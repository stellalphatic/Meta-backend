// avatar-backend/services/supabase.js
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey); // For client-side operations (e.g., auth)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey); // For server-side operations bypassing RLS

module.exports = { supabase, supabaseAdmin };