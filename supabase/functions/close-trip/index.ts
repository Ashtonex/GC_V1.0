// Edge Function: close-trip — Close a trip after the engine close check runs on the server.
import { handleCloseTrip } from '../_shared/handlers.ts';
import { serve } from '../_shared/supabase.ts';

declare const Deno: { serve(h: (req: Request) => Promise<Response>): void };

Deno.serve(serve((body, { caller, gateway }) => handleCloseTrip(body, caller, gateway)));
