// Edge Function: approve — Approve / dispute / evidence-review an expense (Owner any amount, Accounts up to limit).
import { handleOfficeEvent } from '../_shared/handlers.ts';
import { serve } from '../_shared/supabase.ts';

declare const Deno: { serve(h: (req: Request) => Promise<Response>): void };

Deno.serve(serve((body, { caller, gateway }) => handleOfficeEvent(body, caller, gateway, 'EXPENSE_REVIEWED')));
