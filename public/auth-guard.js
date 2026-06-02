/**
 * auth-guard.js — Protección de páginas autenticadas
 * 
 * Incluir en todas las páginas protegidas:
 * <script src="auth-guard.js"></script>
 * 
 * Verifica que exista token válido, sino redirige al login.
 */

(function() {
    // Restaurar sesión desde localStorage si está disponible
    const token = localStorage.getItem('sessionToken');
    const role = localStorage.getItem('userRole');
    const email = localStorage.getItem('userEmail');
    
    // Exponer variables globales
    window.__sessionToken = token;
    window.__userRole = role || 'user';
    window.__userEmail = email;
    
    // Si no hay token, redirigir al login
    if (!token) {
        console.warn('[auth-guard] No hay token válido, redirigiendo a login');
        window.location.href = 'index.html';
    } else {
        console.log('[auth-guard] Token válido restaurado para usuario:', email);
    }
    
    /**
     * authFetch — wrapper que inyecta el token en cada petición
     */
    window.authFetch = async function(url, options = {}) {
        const storedToken = localStorage.getItem('sessionToken');
        if (!storedToken) {
            console.warn('[authFetch] Token expirado, redirigiendo a login');
            window.location.href = 'index.html';
            return new Response(JSON.stringify({ error: 'No autenticado' }), { status: 401 });
        }
        
        const headers = Object.assign({}, options.headers || {});
        headers['Authorization'] = 'Bearer ' + storedToken;
        return fetch(url, Object.assign({}, options, { headers }));
    };
    
    /**
     * Helper: ¿el usuario actual es admin?
     */
    window.isAdmin = function() {
        return window.__userRole === 'admin';
    };
    
    /**
     * handleLogout — limpiar sesión y redirigir al login
     */
    window.handleLogout = function() {
        localStorage.removeItem('sessionToken');
        localStorage.removeItem('userRole');
        localStorage.removeItem('userEmail');
        window.__sessionToken = null;
        window.__userRole = 'user';
        window.__userEmail = null;
        window.location.href = 'index.html';
    };
    
    /**
     * Exponer variables al window para acceso en HTML/scripts
     */
    window.getUserRole = () => window.__userRole;
    window.getUserEmail = () => window.__userEmail;
})();
