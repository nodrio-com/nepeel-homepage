import { createClient } from "@supabase/supabase-js";
import { required } from "./env.js";
export function certificateService() {
  return createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              AbortSignal.timeout(12_000),
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
      },
    },
  );
}
