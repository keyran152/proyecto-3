import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = "https://vuievlksbricfqqsublo.supabase.co";
const supabasePublishableKey = "sb_publishable_mHWzWvgMznF802Tt316YDQ_u93FNc-p";

export const supabase = createClient(supabaseUrl, supabasePublishableKey);