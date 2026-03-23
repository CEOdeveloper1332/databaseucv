-- DEPRECATED: Este archivo ya no es necesario.
-- Los usuarios y aprobaciones se gestionan únicamente en MongoDB.
-- No se requieren triggers en Supabase.

-- Trigger: fires after auth user email is updated
DROP TRIGGER IF EXISTS trigger_on_auth_user_updated ON auth.users;
CREATE TRIGGER trigger_on_auth_user_updated
AFTER UPDATE OF email ON auth.users
FOR EACH ROW
WHEN (OLD.email IS DISTINCT FROM NEW.email)
EXECUTE FUNCTION public.on_auth_user_updated();
