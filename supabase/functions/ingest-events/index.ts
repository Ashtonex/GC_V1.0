// Edge Function: ingest-events — Driver outbox and office uploads (M2 API; outbox client in M3).
import { handleIngest } from '../_shared/handlers.ts';
import { serve } from '../_shared/supabase.ts';

declare const Deno: { serve(h: (req: Request) => Promise<Response>): void };

Deno.serve(serve((body, { caller, gateway }) => handleIngest(body, caller, gateway)));
