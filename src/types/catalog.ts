export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      catalog_admins: {
        Row: {
          granted_at: string
          note: string | null
          user_id: string
        }
        Insert: {
          granted_at?: string
          note?: string | null
          user_id: string
        }
        Update: {
          granted_at?: string
          note?: string | null
          user_id?: string
        }
        Relationships: []
      }
      catalog_bump_limits: {
        Row: {
          bumps: number
          user_id: string
          window_start: string
        }
        Insert: {
          bumps?: number
          user_id: string
          window_start: string
        }
        Update: {
          bumps?: number
          user_id?: string
          window_start?: string
        }
        Relationships: []
      }
      catalog_identifiers: {
        Row: {
          created_at: string
          id: string
          identifier_type: string
          identifier_value: string
          product_id: string
          source: string
        }
        Insert: {
          created_at?: string
          id?: string
          identifier_type?: string
          identifier_value: string
          product_id: string
          source: string
        }
        Update: {
          created_at?: string
          id?: string
          identifier_type?: string
          identifier_value?: string
          product_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_identifiers_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "catalog_products"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_listings: {
        Row: {
          available: boolean
          currency: string | null
          external_id: string
          first_seen_at: string
          id: string
          last_price_at: string | null
          last_seen_at: string
          previous_price: number | null
          price: number | null
          product_id: string
          product_url: string
          retailer_brand: string | null
          retailer_category: string | null
          retailer_id: string
          retailer_name: string
          updated_at: string
        }
        Insert: {
          available?: boolean
          currency?: string | null
          external_id: string
          first_seen_at?: string
          id?: string
          last_price_at?: string | null
          last_seen_at?: string
          previous_price?: number | null
          price?: number | null
          product_id: string
          product_url: string
          retailer_brand?: string | null
          retailer_category?: string | null
          retailer_id: string
          retailer_name: string
          updated_at?: string
        }
        Update: {
          available?: boolean
          currency?: string | null
          external_id?: string
          first_seen_at?: string
          id?: string
          last_price_at?: string | null
          last_seen_at?: string
          previous_price?: number | null
          price?: number | null
          product_id?: string
          product_url?: string
          retailer_brand?: string | null
          retailer_category?: string | null
          retailer_id?: string
          retailer_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_listings_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "catalog_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "catalog_listings_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "catalog_retailers"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_merge_rejections: {
        Row: {
          product_a: string
          product_b: string
          rejected_at: string
          rejected_by: string | null
        }
        Insert: {
          product_a: string
          product_b: string
          rejected_at?: string
          rejected_by?: string | null
        }
        Update: {
          product_a?: string
          product_b?: string
          rejected_at?: string
          rejected_by?: string | null
        }
        Relationships: []
      }
      catalog_product_merges: {
        Row: {
          drop_id: string
          drop_row: Json
          id: string
          identifier_ids: string[]
          keep_id: string
          listing_ids: string[]
          merged_at: string
          merged_by: string | null
          source: string
          undone_at: string | null
        }
        Insert: {
          drop_id: string
          drop_row: Json
          id?: string
          identifier_ids?: string[]
          keep_id: string
          listing_ids?: string[]
          merged_at?: string
          merged_by?: string | null
          source: string
          undone_at?: string | null
        }
        Update: {
          drop_id?: string
          drop_row?: Json
          id?: string
          identifier_ids?: string[]
          keep_id?: string
          listing_ids?: string[]
          merged_at?: string
          merged_by?: string | null
          source?: string
          undone_at?: string | null
        }
        Relationships: []
      }
      catalog_products: {
        Row: {
          add_count: number
          brand: string | null
          canonical_name: string
          category: string | null
          first_seen_at: string
          id: string
          listing_count: number
          match_key: string | null
          merge_key: string
          popularity: number | null
          quantity: number | null
          quantity_unit: string | null
          search_blob: string
          updated_at: string
        }
        Insert: {
          add_count?: number
          brand?: string | null
          canonical_name: string
          category?: string | null
          first_seen_at?: string
          id?: string
          listing_count?: number
          match_key?: string | null
          merge_key?: string
          popularity?: number | null
          quantity?: number | null
          quantity_unit?: string | null
          search_blob?: string
          updated_at?: string
        }
        Update: {
          add_count?: number
          brand?: string | null
          canonical_name?: string
          category?: string | null
          first_seen_at?: string
          id?: string
          listing_count?: number
          match_key?: string | null
          merge_key?: string
          popularity?: number | null
          quantity?: number | null
          quantity_unit?: string | null
          search_blob?: string
          updated_at?: string
        }
        Relationships: []
      }
      catalog_retailers: {
        Row: {
          country: string
          created_at: string
          domain: string
          enabled: boolean
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          country: string
          created_at?: string
          domain: string
          enabled?: boolean
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          country?: string
          created_at?: string
          domain?: string
          enabled?: boolean
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      catalog_run_logs: {
        Row: {
          fields: Json | null
          id: number
          level: string
          message: string
          run_id: string
          scope: string
          t: string
        }
        Insert: {
          fields?: Json | null
          id?: never
          level: string
          message: string
          run_id: string
          scope: string
          t: string
        }
        Update: {
          fields?: Json | null
          id?: never
          level?: string
          message?: string
          run_id?: string
          scope?: string
          t?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_run_logs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "catalog_scrape_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_scrape_runs: {
        Row: {
          conflicts: number
          error: string | null
          error_count: number
          finished_at: string | null
          id: string
          identifiers_added: number
          inserted: number
          last_alive_at: string | null
          marked_unavailable: number
          pages_read: number
          products_created: number
          products_found: number
          products_rejected: number
          products_valid: number
          progress_done: number | null
          progress_total: number | null
          progress_unit: string | null
          retailer_id: string
          started_at: string
          stats: Json
          status: string
          unchanged: number
          updated: number
        }
        Insert: {
          conflicts?: number
          error?: string | null
          error_count?: number
          finished_at?: string | null
          id?: string
          identifiers_added?: number
          inserted?: number
          last_alive_at?: string | null
          marked_unavailable?: number
          pages_read?: number
          products_created?: number
          products_found?: number
          products_rejected?: number
          products_valid?: number
          progress_done?: number | null
          progress_total?: number | null
          progress_unit?: string | null
          retailer_id: string
          started_at?: string
          stats?: Json
          status?: string
          unchanged?: number
          updated?: number
        }
        Update: {
          conflicts?: number
          error?: string | null
          error_count?: number
          finished_at?: string | null
          id?: string
          identifiers_added?: number
          inserted?: number
          last_alive_at?: string | null
          marked_unavailable?: number
          pages_read?: number
          products_created?: number
          products_found?: number
          products_rejected?: number
          products_valid?: number
          progress_done?: number | null
          progress_total?: number | null
          progress_unit?: string | null
          retailer_id?: string
          started_at?: string
          stats?: Json
          status?: string
          unchanged?: number
          updated?: number
        }
        Relationships: [
          {
            foreignKeyName: "catalog_scrape_runs_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "catalog_retailers"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_stats_cache: {
        Row: {
          counted_at: string
          countries: Json
          id: boolean
          retailers: Json
          totals: Json
        }
        Insert: {
          counted_at: string
          countries?: Json
          id?: boolean
          retailers: Json
          totals: Json
        }
        Update: {
          counted_at?: string
          countries?: Json
          id?: boolean
          retailers?: Json
          totals?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bump_product_popularity: {
        Args: { p_maker?: string; p_name: string }
        Returns: undefined
      }
      catalog_admin_create_product: {
        Args: {
          p_barcode?: string
          p_brand?: string
          p_category?: string
          p_name: string
          p_quantity?: number
          p_quantity_unit?: string
        }
        Returns: string
      }
      catalog_admin_delete_product: {
        Args: { p_id: string }
        Returns: undefined
      }
      catalog_admin_merge: {
        Args: { p_drop: string; p_keep: string }
        Returns: string
      }
      catalog_admin_merges: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: {
          drop_name: string
          id: string
          keep_id: string
          keep_name: string
          merged_at: string
          merged_by: string
          source: string
          total: number
          undone_at: string
        }[]
      }
      catalog_admin_near_duplicates: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: {
          family: string
          products: Json
          total: number
        }[]
      }
      catalog_admin_products: {
        Args: {
          p_added_since?: string
          p_available?: boolean
          p_category?: string
          p_earned?: boolean
          p_has_barcode?: boolean
          p_has_brand?: boolean
          p_has_listing?: boolean
          p_has_quantity?: boolean
          p_limit?: number
          p_offset?: number
          p_query?: string
          p_retailer?: string
        }
        Returns: {
          add_count: number
          available: boolean
          barcodes: string[]
          brand: string
          canonical_name: string
          category: string
          currency: string
          first_seen_at: string
          id: string
          listing_count: number
          merge_key: string
          min_price: number
          popularity: number
          quantity: number
          quantity_unit: string
          retailers: string[]
          total_count: number
        }[]
      }
      catalog_admin_reject_group: {
        Args: { p_ids: string[] }
        Returns: undefined
      }
      catalog_admin_run_listings: {
        Args: {
          p_kind: string
          p_limit?: number
          p_offset?: number
          p_run_id: string
        }
        Returns: {
          available: boolean
          currency: string
          external_id: string
          name: string
          previous_price: number
          price: number
          product_url: string
          total: number
        }[]
      }
      catalog_admin_unmerge: {
        Args: { p_merge_id: string }
        Returns: undefined
      }
      catalog_admin_update_product: {
        Args: {
          p_barcode?: string
          p_brand?: string
          p_category?: string
          p_id: string
          p_name?: string
          p_quantity?: number
          p_quantity_unit?: string
        }
        Returns: undefined
      }
      catalog_backfill_match_keys: {
        Args: { p_after: string; p_limit?: number }
        Returns: string
      }
      catalog_canonical_quantity: {
        Args: { p_quantity: number; p_unit: string }
        Returns: string
      }
      catalog_display_name: {
        Args: { p_canonical: string; p_markets: string[]; p_product_id: string }
        Returns: string
      }
      catalog_import_listings: {
        Args: { p_retailer: string; p_rows: Json; p_run_id?: string }
        Returns: Json
      }
      catalog_is_admin: { Args: never; Returns: boolean }
      catalog_key_fold: { Args: { p_text: string }; Returns: string }
      catalog_like_escape: { Args: { p_text: string }; Returns: string }
      catalog_match_family: { Args: { p_match_key: string }; Returns: string }
      catalog_match_groups: {
        Args: never
        Returns: {
          match_key: string
          names: string[]
          product_ids: string[]
          retailers: string[]
        }[]
      }
      catalog_match_key: {
        Args: {
          p_brand: string
          p_name: string
          p_quantity: number
          p_unit: string
        }
        Returns: string
      }
      catalog_merge_key: {
        Args: {
          p_brand: string
          p_name: string
          p_quantity?: number
          p_unit?: string
        }
        Returns: string
      }
      catalog_merge_products: {
        Args: { p_drop: string; p_keep: string; p_source: string }
        Returns: string
      }
      catalog_normalize: { Args: { p_text: string }; Returns: string }
      catalog_number_key: { Args: { p_value: number }; Returns: string }
      catalog_purge_listings: {
        Args: { p_external_ids: string[]; p_retailer: string }
        Returns: Json
      }
      catalog_refresh_search_blob: {
        Args: { p_product_id: string }
        Returns: undefined
      }
      catalog_run_alive: {
        Args: {
          p_done?: number
          p_pages?: number
          p_run_id: string
          p_total?: number
          p_unit?: string
        }
        Returns: undefined
      }
      catalog_run_complete: {
        Args: { p_covered_index?: boolean; p_run_id: string }
        Returns: Json
      }
      catalog_run_fail: {
        Args: { p_error: string; p_run_id: string }
        Returns: undefined
      }
      catalog_run_log: {
        Args: { p_lines: Json; p_run_id: string }
        Returns: number
      }
      catalog_run_open: { Args: { p_retailer: string }; Returns: string }
      catalog_run_partial: {
        Args: { p_reason: string; p_run_id: string }
        Returns: undefined
      }
      catalog_run_progress: {
        Args: {
          p_error_count?: number
          p_products_found?: number
          p_products_rejected?: number
          p_products_valid?: number
          p_run_id: string
          p_stats?: Json
        }
        Returns: undefined
      }
      catalog_run_reap: { Args: { p_older_than?: string }; Returns: number }
      catalog_search_weights: { Args: never; Returns: Json }
      catalog_shops_for: {
        Args: { p_markets?: string[]; p_names: string[] }
        Returns: {
          maker: string
          name: string
          retailers: string[]
        }[]
      }
      catalog_stats: { Args: never; Returns: Json }
      catalog_stats_refresh: { Args: never; Returns: undefined }
      catalog_strip_quantity: { Args: { p_name: string }; Returns: string }
      catalog_unmerge: { Args: { p_merge_id: string }; Returns: undefined }
      lookup_barcode: {
        Args: { p_codes: string[]; p_langs?: string[]; p_markets?: string[] }
        Returns: {
          maker: string
          name: string
          popularity: number
        }[]
      }
      requesting_user_id: { Args: never; Returns: string }
      search_catalog: {
        Args: {
          p_fuzzy?: boolean
          p_langs?: string[]
          p_limit?: number
          p_markets?: string[]
          p_query: string
          p_retailers?: string[]
        }
        Returns: {
          available: boolean
          currency: string
          maker: string
          match_type: string
          min_price: number
          name: string
          popularity: number
          quantity: number
          quantity_unit: string
          relevance_score: number
          retailers: string[]
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

