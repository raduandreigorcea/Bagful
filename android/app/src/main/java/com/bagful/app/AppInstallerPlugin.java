package com.bagful.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/**
 * Installing a new Bagful APK from inside the old one.
 *
 * Bagful ships as a downloadable APK rather than through a store, so nothing
 * updates it on the user's behalf. The web layer finds out that a newer release
 * exists (see src/lib/nativeUpdate.ts); this is the half that can actually act
 * on it, because fetching a file to disk and asking Android to install it are
 * both outside what a WebView is allowed to do.
 *
 * Three things here are not obvious:
 *
 *   • The download is native, not fetch(). A WebView download would have to
 *     survive CORS on GitHub's asset redirect and then hand ~30 MB across the
 *     bridge as base64 to be written out. Reading it straight to cacheDir avoids
 *     both, and gives real byte counts to show a progress bar with.
 *
 *   • Redirects are followed by hand. GitHub answers the release-asset URL with
 *     a 302 to objects.githubusercontent.com, and HttpURLConnection's automatic
 *     following is not dependable across a host change — a silently unfollowed
 *     redirect writes a few hundred bytes of HTML into a file named .apk, which
 *     then fails at the installer with nothing explaining why.
 *
 *   • The file goes to the cache directory, which is what the FileProvider in
 *     AndroidManifest.xml is already configured to share (res/xml/file_paths).
 *     A plain file:// Uri has been illegal to hand another app since Android 7,
 *     and the installer is another app.
 */
@CapacitorPlugin(name = "AppInstaller")
public class AppInstallerPlugin extends Plugin {

    private static final String UPDATE_DIR = "updates";
    private static final String UPDATE_FILE = "Bagful-update.apk";
    private static final int MAX_REDIRECTS = 5;
    private static final int BUFFER_SIZE = 64 * 1024;

    /**
     * Drop an APK left over from a previous run.
     *
     * A successful install replaces this process, so there is no "after the
     * install" moment in this app to clean up from — the download used to be
     * cleared only at the start of the *next* one, which left ~30 MB sitting in
     * the cache directory indefinitely on a device that had updated once.
     * Startup is the next moment we are running at all, and by then the file has
     * either been installed or abandoned; either way nothing needs it.
     */
    @Override
    public void load() {
        File stale = new File(new File(getContext().getCacheDir(), UPDATE_DIR), UPDATE_FILE);
        if (stale.exists() && !stale.delete()) {
            // Cache files are the OS's to reclaim if we cannot. Nothing to report.
            stale.deleteOnExit();
        }
    }

    /**
     * Whether Android would let this app install a package right now.
     *
     * Since Android 8 the "install unknown apps" consent is per-app and cannot be
     * requested from a dialog — only granted by the user on a settings screen. So
     * this is a question asked before the download rather than a permission
     * request: there is no point spending 30 MB of someone's data to arrive at a
     * refusal. Below 26 the setting is device-wide and unreadable from here, so
     * the honest answer is "try it and see".
     */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            result.put("granted", getContext().getPackageManager().canRequestPackageInstalls());
        } else {
            result.put("granted", true);
        }
        call.resolve(result);
    }

    /** Opens the per-app "install unknown apps" screen for Bagful. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Nothing per-app to open; the device-wide toggle lives in Security.
            call.resolve();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not open the install-permission settings.", error);
        }
    }

    /**
     * Downloads the APK at {@code url} and hands it to the system installer.
     *
     * Resolves once the installer has the package — not when the install
     * finishes. From that point the user is in Android's flow and this process is
     * about to be replaced, so there is no completion for us to wait on.
     */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("No download URL.");
            return;
        }

        // On its own thread rather than relying on where Capacitor happens to
        // dispatch plugin calls: this one holds a socket open for tens of seconds
        // and must not be anywhere near the UI thread.
        new Thread(() -> {
            try {
                File apk = download(url);
                launchInstaller(apk);
                call.resolve();
            } catch (Exception error) {
                call.reject("Could not download the update.", error);
            }
        }).start();
    }

    private File download(String url) throws Exception {
        File directory = new File(getContext().getCacheDir(), UPDATE_DIR);
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("Could not create the download directory.");
        }
        File target = new File(directory, UPDATE_FILE);
        // A previous attempt that died mid-write leaves a truncated file behind,
        // and a truncated APK is a file the installer rejects rather than one it
        // ignores. Start from nothing every time.
        if (target.exists() && !target.delete()) {
            throw new IllegalStateException("Could not clear the previous download.");
        }

        HttpURLConnection connection = null;
        try {
            connection = open(url);
            long total = connection.getContentLengthLong();
            long loaded = 0;
            long lastNotified = 0;

            try (InputStream input = connection.getInputStream();
                 OutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[BUFFER_SIZE];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    loaded += read;
                    // Every chunk would be several hundred bridge messages for a
                    // bar that is 6 pixels tall. Half a percent is past the point
                    // where another update would be visible.
                    if (total <= 0 || loaded - lastNotified >= total / 200 || loaded == total) {
                        lastNotified = loaded;
                        notifyProgress(loaded, total);
                    }
                }
            }

            // A connection cut halfway looks exactly like a completed download
            // until the installer opens the file and finds it short. Catch it here
            // instead, where the message can still say what happened.
            if (total > 0 && loaded != total) {
                throw new IllegalStateException("The download ended early.");
            }
            return target;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * Rejects anything that is not an https URL on a GitHub host.
     *
     * This is checked on the initial URL and again on every redirect target,
     * because following redirects by hand means opting out of the protection
     * that comes with not doing so: HttpURLConnection refuses to follow
     * https→http automatically, and setInstanceFollowRedirects(false) below
     * turns that refusal off along with everything else. HttpsURLConnection
     * extends HttpURLConnection, so the cast in open() succeeds just as happily
     * for a plaintext hop — nothing would have complained.
     *
     * The host allowlist is not the load-bearing half (the signing key is: an
     * APK signed with a different one cannot install over Bagful). It is here
     * because the URL's only legitimate source is the release API, so anything
     * else is already wrong by the time it reaches this method.
     */
    private void requireTrustedUrl(URL url) {
        if (!"https".equalsIgnoreCase(url.getProtocol())) {
            throw new SecurityException("Refusing a non-https download URL.");
        }
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
        boolean trusted = host.equals("github.com") || host.endsWith(".githubusercontent.com");
        if (!trusted) {
            throw new SecurityException("Refusing a download from an unexpected host.");
        }
    }

    /** Opens {@code url}, following redirects across hosts itself. */
    private HttpURLConnection open(String url) throws Exception {
        String current = url;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            URL parsed = new URL(current);
            requireTrustedUrl(parsed);
            HttpURLConnection connection = (HttpURLConnection) parsed.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("Accept", "application/octet-stream");
            connection.connect();

            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null) throw new IllegalStateException("Redirect with no target.");
                // Resolved against the current URL so a relative Location works.
                current = new URL(new URL(current), location).toString();
                continue;
            }
            if (status != HttpURLConnection.HTTP_OK) {
                connection.disconnect();
                throw new IllegalStateException("The download server answered " + status + ".");
            }
            return connection;
        }
        throw new IllegalStateException("Too many redirects.");
    }

    private void notifyProgress(long loaded, long total) {
        JSObject event = new JSObject();
        event.put("loaded", loaded);
        event.put("total", total);
        notifyListeners("downloadProgress", event);
    }

    private void launchInstaller(File apk) {
        Uri uri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            apk
        );

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        // The installer is a different app reading a file in our cache; without
        // this it gets a Uri it is not allowed to open.
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> activity.startActivity(intent));
        } else {
            getContext().startActivity(intent);
        }
    }
}
