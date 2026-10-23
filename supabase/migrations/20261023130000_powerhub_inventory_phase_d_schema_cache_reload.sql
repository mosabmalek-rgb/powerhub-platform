-- Phase D financial details changed RPC signatures; reload PostgREST's schema cache.
notify pgrst, 'reload schema';
