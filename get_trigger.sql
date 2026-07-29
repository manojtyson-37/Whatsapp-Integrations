SELECT 
    t.tgname AS trigger_name,
    p.proname AS function_name,
    pg_get_functiondef(p.oid) AS function_definition
FROM 
    pg_trigger t
JOIN 
    pg_proc p ON t.tgfoid = p.oid
WHERE 
    t.tgrelid = 'auth.users'::regclass;
