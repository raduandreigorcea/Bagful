package com.bagful.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that ship as npm packages are discovered from their own
        // manifests; one living in the app module is not, so it has to be named
        // here — and before super.onCreate(), which is where the bridge is built
        // and the plugin list is read. Registered after it, AppInstaller exists in
        // the APK but not in the WebView, and the update dialog reports that it
        // cannot install anything.
        registerPlugin(AppInstallerPlugin.class);
        super.onCreate(savedInstanceState);

        // Draw behind the status and navigation bars on every Android version,
        // not only on 15+ where the system forces it.
        //
        // The web layer pads itself by --safe-top / --safe-bottom, which
        // Capacitor's SystemBars fills from the real bar sizes. Below Android 15
        // the window used to stop at the bars on its own, so those paddings were
        // spent a second time: an empty band under the status bar and another
        // under the composer (seen on a moto g60s, Android 12). Edge to edge
        // everywhere makes the inset the page is told about the space it
        // actually has to leave.
        //
        // AFTER super.onCreate(), which is where BridgeActivity swaps the splash
        // theme for AppTheme.NoActionBar. Enabling this before it touched the
        // window's decor while the splash theme was still on, and the window
        // was built with that theme's action bar: a white title strip reading
        // "Bagful Nightly" over the top of the app.
        //
        // Transparent in both directions; lib/theme.ts picks light or dark icons
        // to match the app's theme through SystemBars.setStyle.
        EdgeToEdge.enable(
            this,
            SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT)
        );
        // With 3-button navigation Android lays a translucent scrim behind the
        // buttons "for contrast". The composer already sits on the page's own
        // colour there, so the scrim only greys the bottom edge.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }
    }
}
