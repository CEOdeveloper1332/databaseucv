"""
Microservicio Flask para notificar al administrador y gestionar aprobaciones.

Requerimientos:
pip install flask flask-cors

Variables de entorno recomendadas:
- SMTP_HOST
- SMTP_PORT
- SMTP_USER
- SMTP_PASS
- FROM_EMAIL (opcional; por defecto SMTP_USER)
- ADMIN_EMAIL (por defecto: studiosgameceo@gmail.com)
- FRONTEND_URL (URL pública o local donde está index.html, por defecto http://localhost:5500/)

Uso:
python admin_api.py
"""
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
import os, json, smtplib, datetime, urllib.parse

APPROVALS_FILE = os.path.join(os.path.dirname(__file__), 'approvals.json')
SMTP_HOST = os.environ.get('SMTP_HOST', 'smtp.example.com')
SMTP_PORT = int(os.environ.get('SMTP_PORT', 587))
SMTP_USER = os.environ.get('SMTP_USER', '')
SMTP_PASS = os.environ.get('SMTP_PASS', '')
FROM_EMAIL = os.environ.get('FROM_EMAIL', SMTP_USER)
ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', 'studiosgameceo@gmail.com')
FRONTEND_URL = os.environ.get('FRONTEND_URL', 'http://localhost:5500/')  # Ajustar según despliegue
SERVER_HOST = os.environ.get('SERVER_HOST', 'localhost')
SERVER_PORT = int(os.environ.get('SERVER_PORT', 5000))

app = Flask(__name__)
CORS(app)

def load_approvals():
    try:
        with open(APPROVALS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def save_approvals(data):
    with open(APPROVALS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def send_email(subject, body, to_addr):
    if not SMTP_USER or not SMTP_PASS or not SMTP_HOST:
        print('SMTP not configured; skipping send_email. Subject:', subject)
        return False
    msg = f"From: {FROM_EMAIL}\r\nTo: {to_addr}\r\nSubject: {subject}\r\n\r\n{body}"
    try:
        s = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10)
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.sendmail(FROM_EMAIL, [to_addr], msg.encode('utf-8'))
        s.quit()
        return True
    except Exception as e:
        print('Error sending email:', e)
        return False

@app.route('/notify', methods=['POST'])
def notify():
    data = request.get_json() or {}
    user_email = data.get('user_email')
    user_name = data.get('user_name', '')
    if not user_email:
        return jsonify({'error': 'user_email required'}), 400

    approvals = load_approvals()
    approvals[user_email] = approvals.get(user_email, {})
    approvals[user_email].update({
        'approved': False,
        'role_requested': 'admin',
        'requested_at': datetime.datetime.utcnow().isoformat()
    })
    save_approvals(approvals)

    # Enlaces para el administrador (aprobación/denegar) apuntan al servidor
    base_server = f'http://{SERVER_HOST}:{SERVER_PORT}'
    approve_link = f'{base_server}/approve?email={urllib.parse.quote(user_email)}&role=admin'
    deny_link = f'{base_server}/deny?email={urllib.parse.quote(user_email)}'

    subject = f'Solicitud de acceso ADMIN: {user_name} <{user_email}>'
    body = f"""
Solicitud de acceso ADMIN para A1 Analytics:

Usuario: {user_name}
Email: {user_email}
Fecha: {datetime.datetime.utcnow().isoformat()} UTC

Aprobar: {approve_link}
Denegar: {deny_link}

(Estos enlaces gestionan la aprobación en el servidor.)
"""
    sent = send_email(subject, body, ADMIN_EMAIL)
    return jsonify({'sent': sent}), (200 if sent else 500)

@app.route('/approve', methods=['GET'])
def approve():
    email = request.args.get('email')
    role = request.args.get('role', 'admin')
    if not email:
        return 'email missing', 400
    approvals = load_approvals()
    approvals[email] = approvals.get(email, {})
    approvals[email].update({'approved': True, 'role': role, 'approved_at': datetime.datetime.utcnow().isoformat()})
    save_approvals(approvals)
    # Redirigir a frontend indicando que fue aprobado (frontend hará el resto)
    redirect_to = f"{FRONTEND_URL}?approved_by_admin=1"
    return redirect(redirect_to)

@app.route('/deny', methods=['GET'])
def deny():
    email = request.args.get('email')
    if not email:
        return 'email missing', 400
    approvals = load_approvals()
    approvals[email] = approvals.get(email, {})
    approvals[email].update({'approved': False, 'role': approvals.get(email, {}).get('role', 'user'), 'denied_at': datetime.datetime.utcnow().isoformat()})
    save_approvals(approvals)
    return f'Usuario {email} denegado.', 200

@app.route('/status', methods=['GET'])
def status():
    email = request.args.get('email')
    if not email:
        return jsonify({'error': 'email required'}), 400
    approvals = load_approvals()
    record = approvals.get(email, {})
    return jsonify({
        'approved': bool(record.get('approved', False)),
        'role': record.get('role', record.get('role_requested', 'user')),
        'requested_at': record.get('requested_at')
    })

if __name__ == '__main__':
    # Crear archivo si no existe
    if not os.path.exists(APPROVALS_FILE):
        save_approvals({})
    print(f'Starting admin_api on {SERVER_HOST}:{SERVER_PORT}')
    app.run(host=SERVER_HOST, port=SERVER_PORT)
