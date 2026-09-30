/**
 * Typed shape of the Mandi-Sync Supabase public schema.
 * Keep in sync with supabase/migrations/001_initial_schema.sql
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      mandis: {
        Row: {
          id: string;
          state: string;
          district: string;
          market_name: string;
          /** WKB/EWKT from PostGIS; prefer lat/lng via RPC helpers in app code */
          location_geom: unknown;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          state: string;
          district: string;
          market_name: string;
          location_geom: unknown;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          state?: string;
          district?: string;
          market_name?: string;
          location_geom?: unknown;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      mandi_prices: {
        Row: {
          id: string;
          mandi_id: string;
          commodity: string;
          variety: string | null;
          min_price: number | null;
          max_price: number | null;
          modal_price: number;
          price_date: string;
          is_forecasted: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          mandi_id: string;
          commodity: string;
          variety?: string | null;
          min_price?: number | null;
          max_price?: number | null;
          modal_price: number;
          price_date: string;
          is_forecasted?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          mandi_id?: string;
          commodity?: string;
          variety?: string | null;
          min_price?: number | null;
          max_price?: number | null;
          modal_price?: number;
          price_date?: string;
          is_forecasted?: boolean;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "mandi_prices_mandi_id_fkey";
            columns: ["mandi_id"];
            isOneToOne: false;
            referencedRelation: "mandis";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_mandis_within_radius: {
        Args: {
          lat: number;
          lng: number;
          radius_km?: number;
        };
        Returns: {
          id: string;
          state: string;
          district: string;
          market_name: string;
          lat: number;
          lng: number;
          distance_km: number;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export type Mandi = Database["public"]["Tables"]["mandis"]["Row"];
export type MandiInsert = Database["public"]["Tables"]["mandis"]["Insert"];
export type MandiPrice = Database["public"]["Tables"]["mandi_prices"]["Row"];
export type MandiPriceInsert =
  Database["public"]["Tables"]["mandi_prices"]["Insert"];
export type MandiWithinRadius =
  Database["public"]["Functions"]["get_mandis_within_radius"]["Returns"][number];
