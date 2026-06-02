"""
Microservicio Flask — gestión de aprobaciones de acceso ADMIN para A1 Analytics.

Cambios de seguridad respecto a la versión anterior:
- /approve y /deny requieren token HMAC-SHA256 con expiración (1 hora)
- El parámetro 'role' ya NO se acepta del cliente — está fijado en el servidor
- Estado de aprobaciones en MongoDB (misma colección 'users' que server.js)
- Se elimina approvals.json por completo
- /status requiere el mismo token HMAC para evitar enumeración de usuarios
- CORS restringido a ALLOWED_ORIGINS

Variables de entorno requeridas:
  APPROVAL_SECRET    — clave aleatoria larga para firmar tokens (mínimo 32 chars)
  MONGODB_URI        — misma URI que usa server.js
  MONGODB_DB         — nombre de la base de datos (por defecto: test)

Variables de entorno opcionales:
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL
  ADMIN_EMAIL        — destino de notificaciones (por defecto: studiosgameceo@gmail.com)
  FRONTEND_URL       — URL base del frontend (por defecto: http://localhost:5500/)
  SERVER_HOST        — host de este microservicio (por defecto: localhost)
  SERVER_PORT        — puerto de este microservicio (por defecto: 5000)
  ALLOWED_ORIGINS    — orígenes CORS permitidos separados por coma

Uso:
  pip install flask flask-cors pymongo
  python admin_api.py
"""

import os
import hmac
import hashlib
import time
import smtplib
import datetime
import urllib.parse
import secrets

from flask import Flask, request, jsonify, redirect, abort
from flask_cors import CORS
from pymongo import MongoClient

# ── Configuración desde entorno ──────────────────────────────────────────────

def _require_env(name):
    val = os.environ.get(name, '').strip()
    if not val:
        raise RuntimeError(f'Variable de entorno requerida no configurada: {name}')
    return val

APPROVAL_SECRET = _require_env('APPROVAL_SECRET')   # mínimo 32 chars aleatorios
MONGODB_URI     = _require_env('MONGODB_URI')
MONGODB_DB      = os.environ.get('MONGODB_DB', 'test')

SMTP_HOST   = os.environ.get('SMTP_HOST', '')
SMTP_PORT   = int(os.environ.get('SMTP_PORT', 587))
SMTP_USER   = os.environ.get('SMTP_USER', '')
SMTP_PASS   = os.environ.get('SMTP_PASS', '')
FROM_EMAIL  = os.environ.get('FROM_EMAIL', SMTP_USER)
ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', 'studiosgameceo@gmail.com')

FRONTEND_URL = os.environ.get('FRONTEND_URL', 'http://localhost:5500/')
SERVER_HOST  = os.environ.get('SERVER_HOST', 'localhost')
SERVER_PORT  = int(os.environ.get('SERVER_PORT', 5000))

TOKEN_TTL_SECONDS = 3600  # los enlaces expiran en 1 hora

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get('ALLOWED_ORIGINS', '').split(',')
    if o.strip()
]

# ── Flask + CORS ─────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app, origins=ALLOWED_ORIGINS if ALLOWED_ORIGINS else ['http://localhost:5500'])

# ── MongoDB ──────────────────────────────────────────────────────────────────

_mongo_client = MongoClient(MONGODB_URI)
_db = _mongo_client[MONGODB_DB]

def users_col():
    return _db['users']

# ── HMAC token ───────────────────────────────────────────────────────────────
# Formato: "<action>:<email>:<timestamp_unix>"
# Firma:   HMAC-SHA256(secret, mensaje)
# El token que va en la URL es: "<timestamp>.<hex_firma>"

def _make_token(action: str, email: str, ts: int) -> str:
    msg = f'{action}:{email}:{ts}'.encode('utf-8')
    sig = hmac.new(APPROVAL_SECRET.encode('utf-8'), msg, hashlib.sha256).hexdigest()
    return f'{ts}.{sig}'

def generate_token(action: str, email: str) -> str:
    """Genera un token firmado con timestamp actual."""
    ts = int(time.time())
    return _make_token(action, email, ts)

def verify_token(action: str, email: str, token: str) -> bool:
    """
    Verifica firma y expiración.
    Retorna True solo si la firma es válida y el token no expiró.
    """
    try:
        ts_str, sig = token.split('.', 1)
        ts = int(ts_str)
    except (ValueError, AttributeError):
        return False

    # Verificar expiración antes de comparar firmas (fail-fast)
    if time.time() - ts > TOKEN_TTL_SECONDS:
        return False

    expected = _make_token(action, email, ts)
    # compare_digest previene timing attacks
    return hmac.compare_digest(expected, f'{ts_str}.{sig}')

# ── SMTP ─────────────────────────────────────────────────────────────────────

def send_email(subject: str, body: str, to_addr: str) -> bool:
    if not SMTP_USER or not SMTP_PASS or not SMTP_HOST:
        print('[admin_api] SMTP no configurado — email no enviado. Asunto:', subject)
        return False
    headers = (
        f'From: {FROM_EMAIL}\r\n'
        f'To: {to_addr}\r\n'
        f'Subject: {subject}\r\n'
        f'Content-Type: text/plain; charset=utf-8\r\n'
    )
    raw = (headers + '\r\n' + body).encode('utf-8')
    try:
        s = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10)
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.sendmail(FROM_EMAIL, [to_addr], raw)
        s.quit()
        return True
    except Exception as e:
        print('[admin_api] Error enviando email:', e)
        return False

# ── Endpoints ────────────────────────────────────────────────────────────────

@app.route('/notify', methods=['POST'])
def notify():
    """
    Recibe solicitud de acceso admin desde el frontend.
    Registra en MongoDB y envía email al administrador con enlaces firmados.

    Body JSON: { "user_email": "...", "user_name": "..." }
    """
    data = request.get_json(silent=True) or {}
    user_email = (data.get('user_email') or '').strip().lower()
    user_name  = (data.get('user_name') or '').strip()

    if not user_email or '@' not in user_email:
        return jsonify({'error': 'user_email inválido'}), 400

    now = datetime.datetime.utcnow()

    # Registrar/actualizar solicitud en MongoDB
    users_col().update_one(
        {'email': user_email},
        {
            '$set': {
                'email': user_email,
                'name': user_name,
                'approved': False,
                'role_requested': 'admin',
                'requested_at': now.isoformat(),
                'updatedAt': now,
            },
            '$setOnInsert': {
                'role': 'user',
                'createdAt': now,
            }
        },
        upsert=True
    )

    # Generar tokens firmados — role está hardcodeado aquí, nunca viene del cliente
    approve_token = generate_token('approve', user_email)
    deny_token    = generate_token('deny', user_email)

    base_server = f'http://{SERVER_HOST}:{SERVER_PORT}'
    approve_link = (
        f'{base_server}/approve'
        f'?email={urllib.parse.quote(user_email)}'
        f'&token={urllib.parse.quote(approve_token)}'
    )
    deny_link = (
        f'{base_server}/deny'
        f'?email={urllib.parse.quote(user_email)}'
        f'&token={urllib.parse.quote(deny_token)}'
    )

    subject = f'Solicitud de acceso ADMIN: {user_name} <{user_email}>'
    body = f"""Solicitud de acceso ADMIN para A1 Analytics:

Usuario : {user_name}
Email   : {user_email}
Fecha   : {now.isoformat()} UTC

APROBAR (válido 1 hora):
{approve_link}

DENEGAR (válido 1 hora):
{deny_link}

Si los enlaces expiraron, el usuario debe enviar una nueva solicitud.
"""
    sent = send_email(subject, body, ADMIN_EMAIL)
    return jsonify({'sent': sent}), (200 if sent else 500)


@app.route('/approve', methods=['GET'])
def approve():
    """
    Aprueba la solicitud. Solo funciona con token HMAC válido y no expirado.
    El rol concedido es siempre 'admin' — no es configurable por el cliente.
    """
    email = (request.args.get('email') or '').strip().lower()
    token = (request.args.get('token') or '').strip()

    if not email or not token:
        abort(400, 'Parámetros incompletos')

    if not verify_token('approve', email, token):
        # 403 genérico — no revelar si el token expiró o si el email no existe
        abort(403, 'Token inválido o expirado')

    now = datetime.datetime.utcnow()
    result = users_col().update_one(
        {'email': email},
        {
            '$set': {
                'approved': True,
                'role': 'admin',          # hardcodeado — no aceptar del cliente
                'approved_at': now.isoformat(),
                'updatedAt': now,
            }
        }
    )

    if result.matched_count == 0:
        # El usuario no existe en la BD — no aprobar fantasmas
        abort(404, f'Usuario no encontrado: {email}')

    print(f'[admin_api] Aprobado: {email} → role=admin')
    return redirect(f'{FRONTEND_URL}?approved_by_admin=1')


@app.route('/deny', methods=['GET'])
def deny():
    """
    Deniega la solicitud. Solo funciona con token HMAC válido y no expirado.
    """
    email = (request.args.get('email') or '').strip().lower()
    token = (request.args.get('token') or '').strip()

    if not email or not token:
        abort(400, 'Parámetros incompletos')

    if not verify_token('deny', email, token):
        abort(403, 'Token inválido o expirado')

    now = datetime.datetime.utcnow()
    users_col().update_one(
        {'email': email},
        {
            '$set': {
                'approved': False,
                'denied_at': now.isoformat(),
                'updatedAt': now,
            }
        }
    )

    print(f'[admin_api] Denegado: {email}')
    # Respuesta simple de texto — el admin ya sabe lo que hizo
    return f'<p>Usuario <strong>{email}</strong> denegado correctamente.</p>', 200


@app.route('/status', methods=['GET'])
def status():
    """
    Consulta estado de aprobación de un usuario.
    Requiere token HMAC firmado con acción 'status' para evitar enumeración.

    Uso: GET /status?email=<email>&token=<token>
    El token se genera en el servidor cuando el usuario solicita su estado.
    """
    email = (request.args.get('email') or '').strip().lower()
    token = (request.args.get('token') or '').strip()

    if not email or not token:
        return jsonify({'error': 'email y token requeridos'}), 400

    if not verify_token('status', email, token):
        return jsonify({'error': 'Token inválido o expirado'}), 403

    user = users_col().find_one({'email': email}, {'_id': 0, 'approved': 1, 'role': 1, 'requested_at': 1})
    if not user:
        return jsonify({'approved': False, 'role': 'user', 'requested_at': None})

    return jsonify({
        'approved': bool(user.get('approved', False)),
        'role': user.get('role', 'user'),
        'requested_at': user.get('requested_at'),
    })


@app.route('/generate-status-token', methods=['POST'])
def generate_status_token():
    """
    Genera un token de consulta de estado para que el frontend pueda llamar a /status.
    Solo disponible si el solicitante proporciona su propio email (no enumera otros).

    Body JSON: { "user_email": "..." }
    Retorna:   { "token": "...", "expires_in": 3600 }
    """
    data = request.get_json(silent=True) or {}
    user_email = (data.get('user_email') or '').strip().lower()

    if not user_email or '@' not in user_email:
        return jsonify({'error': 'user_email inválido'}), 400

    token = generate_token('status', user_email)
    return jsonify({'token': token, 'expires_in': TOKEN_TTL_SECONDS})


# ── Arranque ─────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print(f'[admin_api] Iniciando en {SERVER_HOST}:{SERVER_PORT}')
    print(f'[admin_api] MongoDB: {MONGODB_URI[:30]}...')
    print(f'[admin_api] SMTP configurado: {bool(SMTP_USER and SMTP_PASS)}')
    app.run(host=SERVER_HOST, port=SERVER_PORT)
