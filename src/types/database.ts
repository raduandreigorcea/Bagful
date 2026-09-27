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
      admin_users: {
        Row: {
          granted_at: string
          granted_by: string | null
          note: string | null
          user_id: string
        }
        Insert: {
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          user_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          user_id?: string
        }
        Relationships: []
      }
      list_members: {
        Row: {
          id: string
          joined_at: string
          list_id: string
          role: string
          user_id: string
        }
        Insert: {
          id?: string
          joined_at?: string
          list_id: string
          role?: string
          user_id: string
        }
        Update: {
          id?: string
          joined_at?: string
          list_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "list_members_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "list_members_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      lists: {
        Row: {
          created_at: string
          created_by: string
          deleted_at: string | null
          emoji: string | null
          id: string
          invite_code: string
          max_items_per_member: number
          name: string
        }
        Insert: {
          created_at?: string
          created_by: string
          deleted_at?: string | null
          emoji?: string | null
          id?: string
          invite_code: string
          max_items_per_member?: number
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          emoji?: string | null
          id?: string
          invite_code?: string
          max_items_per_member?: number
          name?: string
        }
        Relationships: []
      }
      product_catalog: {
        Row: {
          add_count: number
          barcode: string | null
          base_weight: number
          contributed_by: string | null
          created_at: string
          id: string
          list_id: string | null
          maker: string | null
          name: string
          popularity: number | null
          search_aliases: string | null
          search_blob: string | null
          search_text: string
          source: string
          source_ref: string | null
          source_version: string | null
        }
        Insert: {
          add_count?: number
          barcode?: string | null
          base_weight?: number
          contributed_by?: string | null
          created_at?: string
          id?: string
          list_id?: string | null
          maker?: string | null
          name: string
          popularity?: number | null
          search_aliases?: string | null
          search_blob?: string | null
          search_text: string
          source?: string
          source_ref?: string | null
          source_version?: string | null
        }
        Update: {
          add_count?: number
          barcode?: string | null
          base_weight?: number
          contributed_by?: string | null
          created_at?: string
          id?: string
          list_id?: string | null
          maker?: string | null
          name?: string
          popularity?: number | null
          search_aliases?: string | null
          search_blob?: string | null
          search_text?: string
          source?: string
          source_ref?: string | null
          source_version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_catalog_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lists"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          banned_at: string | null
          display_name: string
          image_url: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          banned_at?: string | null
          display_name?: string
          image_url?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          banned_at?: string | null
          display_name?: string
          image_url?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      purchase_history: {
        Row: {
          added_by: string | null
          added_by_image_url: string | null
          added_by_name: string | null
          checkout_id: string
          id: string
          item_id: string | null
          list_id: string
          maker: string | null
          name: string
          purchased_at: string
          purchased_by: string
          quantity: number
        }
        Insert: {
          added_by?: string | null
          added_by_image_url?: string | null
          added_by_name?: string | null
          checkout_id: string
          id?: string
          item_id?: string | null
          list_id: string
          maker?: string | null
          name: string
          purchased_at?: string
          purchased_by: string
          quantity?: number
        }
        Update: {
          added_by?: string | null
          added_by_image_url?: string | null
          added_by_name?: string | null
          checkout_id?: string
          id?: string
          item_id?: string | null
          list_id?: string
          maker?: string | null
          name?: string
          purchased_at?: string
          purchased_by?: string
          quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_history_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lists"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_counters: {
        Row: {
          actor: string
          hits: number
          kind: string
          window_start: string
        }
        Insert: {
          actor: string
          hits?: number
          kind: string
          window_start: string
        }
        Update: {
          actor?: string
          hits?: number
          kind?: string
          window_start?: string
        }
        Relationships: []
      }
      security_events: {
        Row: {
          actor: string | null
          created_at: string
          detail: Json
          id: number
          kind: string
          list_id: string | null
        }
        Insert: {
          actor?: string | null
          created_at?: string
          detail?: Json
          id?: never
          kind: string
          list_id?: string | null
        }
        Update: {
          actor?: string | null
          created_at?: string
          detail?: Json
          id?: never
          kind?: string
          list_id?: string | null
        }
        Relationships: []
      }
      shopping_list_items: {
        Row: {
          added_by: string
          checked: boolean
          checked_at: string | null
          created_at: string
          id: string
          list_id: string
          maker: string | null
          name: string
          quantity: number
        }
        Insert: {
          added_by: string
          checked?: boolean
          checked_at?: string | null
          created_at?: string
          id?: string
          list_id: string
          maker?: string | null
          name: string
          quantity?: number
        }
        Update: {
          added_by?: string
          checked?: boolean
          checked_at?: string | null
          created_at?: string
          id?: string
          list_id?: string
          maker?: string | null
          name?: string
          quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "shopping_list_items_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lists"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      active_list_ids: { Args: never; Returns: string[] }
      add_custom_product: {
        Args: {
          p_barcode?: string
          p_list_id: string
          p_maker?: string
          p_name: string
        }
        Returns: undefined
      }
      add_custom_product_unthrottled: {
        Args: {
          p_barcode?: string
          p_list_id: string
          p_maker?: string
          p_name: string
        }
        Returns: undefined
      }
      admin_activity_series: {
        Args: { p_bucket?: string; p_since?: string }
        Returns: {
          active_users: number
          bucket: string
          checkouts: number
          items_added: number
          items_checked: number
          members_joined: number
          new_lists: number
          purchases: number
        }[]
      }
      admin_ban_user: {
        Args: { p_reason: string; p_user_id: string }
        Returns: undefined
      }
      admin_banned_users: {
        Args: never
        Returns: {
          banned_at: string
          banned_by: string
          banned_by_image_url: string
          banned_by_name: string
          display_name: string
          image_url: string
          lists: number
          reason: string
          user_id: string
        }[]
      }
      admin_catalog_misses: {
        Args: { p_limit?: number }
        Returns: {
          add_count: number
          first_seen: string
          last_seen: string
          lists: number
          maker: string
          name: string
          promoted: boolean
        }[]
      }
      admin_create_product: {
        Args: {
          p_barcode?: string
          p_base_weight?: number
          p_maker?: string
          p_name: string
        }
        Returns: string
      }
      admin_delete_list: { Args: { p_id: string }; Returns: undefined }
      admin_delete_product: { Args: { p_id: string }; Returns: undefined }
      admin_deleted_lists: {
        Args: never
        Returns: {
          deleted_at: string
          emoji: string
          id: string
          items_total: number
          members: number
          name: string
        }[]
      }
      admin_event_digest: {
        Args: { p_since?: string }
        Returns: {
          distinct_actors: number
          events: number
          first_seen: string
          kind: string
          last_seen: string
        }[]
      }
      admin_grant: {
        Args: { p_note?: string; p_user_id: string }
        Returns: undefined
      }
      admin_guard: { Args: never; Returns: undefined }
      admin_health: { Args: never; Returns: Json }
      admin_list_admins: {
        Args: never
        Returns: {
          display_name: string
          granted_at: string
          granted_by: string
          granted_by_image_url: string
          granted_by_name: string
          image_url: string
          is_self: boolean
          note: string
          user_id: string
        }[]
      }
      admin_list_detail: { Args: { p_list_id: string }; Returns: Json }
      admin_list_facts: {
        Args: never
        Returns: {
          checkouts: number
          created_at: string
          created_by: string
          deleted_at: string
          emoji: string
          id: string
          invite_code: string
          items_open: number
          items_total: number
          last_active: string
          max_items_per_member: number
          members: number
          moderators: number
          name: string
          owner_image_url: string
          owner_name: string
          products_added: number
          purchases: number
        }[]
      }
      admin_list_users: {
        Args: {
          p_dir?: string
          p_limit?: number
          p_offset?: number
          p_query?: string
          p_sort?: string
        }
        Returns: {
          display_name: string
          first_seen: string
          image_url: string
          is_admin: boolean
          items_added: number
          items_open: number
          last_active: string
          lists: number
          moderator_of: number
          owned_lists: number
          products_added: number
          purchases: number
          total_count: number
          user_id: string
        }[]
      }
      admin_lists: {
        Args: {
          p_dir?: string
          p_limit?: number
          p_offset?: number
          p_query?: string
          p_sort?: string
        }
        Returns: {
          checkouts: number
          created_at: string
          created_by: string
          emoji: string
          id: string
          invite_code: string
          items_open: number
          items_total: number
          last_active: string
          members: number
          moderators: number
          name: string
          owner_image_url: string
          owner_name: string
          products_added: number
          purchases: number
          total_count: number
        }[]
      }
      admin_local_products: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_query?: string
          p_scope?: string
          p_source?: string
        }
        Returns: {
          add_count: number
          barcode: string
          base_weight: number
          contributed_by: string
          contributor_image_url: string
          contributor_name: string
          created_at: string
          id: string
          list_id: string
          list_name: string
          maker: string
          name: string
          popularity: number
          source: string
          source_version: string
          total_count: number
        }[]
      }
      admin_overview: { Args: { p_since?: string }; Returns: Json }
      admin_rate_limits: {
        Args: { p_limit?: number }
        Returns: {
          actor: string
          actor_image_url: string
          actor_name: string
          hits: number
          kind: string
          window_start: string
        }[]
      }
      admin_recent_activity: {
        Args: { p_limit?: number }
        Returns: {
          actor: string
          actor_image_url: string
          actor_name: string
          detail: Json
          kind: string
          list_id: string
          list_name: string
          occurred_at: string
          subject: string
        }[]
      }
      admin_restore_list: { Args: { p_id: string }; Returns: undefined }
      admin_revoke: { Args: { p_user_id: string }; Returns: undefined }
      admin_security_events: {
        Args: {
          p_actor?: string
          p_kind?: string
          p_limit?: number
          p_offset?: number
          p_since?: string
        }
        Returns: {
          actor: string
          actor_image_url: string
          actor_name: string
          created_at: string
          detail: Json
          id: number
          kind: string
          list_id: string
          list_name: string
          total_count: number
        }[]
      }
      admin_top_purchases: {
        Args: { p_limit?: number; p_since?: string }
        Returns: {
          last_bought: string
          lists: number
          maker: string
          name: string
          quantity: number
          times: number
        }[]
      }
      admin_unban_user: { Args: { p_user_id: string }; Returns: undefined }
      admin_update_product: {
        Args: {
          p_barcode?: string
          p_base_weight?: number
          p_id: string
          p_maker?: string
          p_name: string
        }
        Returns: undefined
      }
      admin_user_detail: { Args: { p_user_id: string }; Returns: Json }
      admin_user_facts: {
        Args: never
        Returns: {
          banned_at: string
          checkouts: number
          display_name: string
          first_seen: string
          image_url: string
          items_added: number
          items_open: number
          last_active: string
          lists: number
          moderator_of: number
          owned_lists: number
          products_added: number
          profile_updated_at: string
          purchases: number
          user_id: string
        }[]
      }
      bump_product_popularity: {
        Args: { p_list_id?: string; p_maker?: string; p_name: string }
        Returns: undefined
      }
      buy_items: { Args: { p_item_ids: string[] }; Returns: number }
      create_list: {
        Args: {
          p_display_name?: string
          p_image_url?: string
          p_invite_code: string
          p_name: string
        }
        Returns: {
          id: string
          name: string
        }[]
      }
      import_catalog_products: {
        Args: {
          p_dry_run?: boolean
          p_rows: Json
          p_source?: string
          p_source_version?: string
        }
        Returns: Json
      }
      is_admin: { Args: never; Returns: boolean }
      is_list_owner_or_moderator: {
        Args: { target_list_id: string }
        Returns: boolean
      }
      is_member_of_list: { Args: { target_list_id: string }; Returns: boolean }
      join_list_with_code: {
        Args: { p_code: string; p_display_name?: string; p_image_url?: string }
        Returns: {
          id: string
          name: string
        }[]
      }
      log_security_event: {
        Args: { p_detail?: Json; p_kind: string; p_list_id?: string }
        Returns: undefined
      }
      merge_items: {
        Args: { p_source: string; p_target: string }
        Returns: number
      }
      product_search_text: {
        Args: { p_maker?: string; p_name: string }
        Returns: string
      }
      rate_limit_hit: {
        Args: { p_kind: string; p_limit: number; p_window: string }
        Returns: boolean
      }
      requesting_user_id: { Args: never; Returns: string }
      search_catalog: {
        Args: { p_limit?: number; p_list_id?: string; p_query: string }
        Returns: {
          maker: string
          name: string
          popularity: number
        }[]
      }
      security_digest: {
        Args: { p_days?: number }
        Returns: {
          distinct_actors: number
          events: number
          first_seen: string
          kind: string
          last_seen: string
        }[]
      }
      shares_list_with: { Args: { target_user_id: string }; Returns: boolean }
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

