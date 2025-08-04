import { createClient } from '@supabase/supabase-js'; 

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
    throw new Error('Environment variable SUPABASE_URL is not set.');
}
if (!supabaseAnonKey) {
    throw new Error('Environment variable SUPABASE_ANON_KEY is not set.');
}
if (!supabaseServiceRoleKey) {
    throw new Error('Environment variable SUPABASE_SERVICE_ROLE_KEY is not set.');
}

const supabase = createClient(supabaseUrl, supabaseAnonKey); // For client-side operations (e.g., auth)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey); // For server-side operations bypassing RLS

export { supabase, supabaseAdmin };
