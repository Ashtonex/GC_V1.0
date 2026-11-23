// Edge Function: verify — Verify or reject an EcoCash / swipe / transfer payment (Owner, Accounts).
import { handleOfficeEvent } from '../_shared/handlers.ts';
import { serve } from '../_shared/supabase.ts';

declare const Deno: { serve(h: (req: Request) => Promise<Response>): void };

Deno.serve(serve((body, { caller, gateway }) => handleOfficeEvent(body, caller, gateway, 'PAYMENT_VERIFIED')));
