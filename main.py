import os
from flask import Flask, render_template, request, jsonify, Response, stream_with_context, session
from ai import call_ai_stream, SYSTEM_PROMPT, call_ai
from storeConversation import save_conversation, get_next_conversation_id
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "your-secret-key-here")

# Register face recognition blueprint
from face_routes import face_bp
app.register_blueprint(face_bp)

import threading
stop_event = threading.Event()

# Warm the schema cache in a background thread at startup to avoid first-request latency
try:
    from ai import _get_or_build_schema
    threading.Thread(target=_get_or_build_schema, daemon=True).start()
except Exception:
    # If warming fails, don't block startup; the cache will be built on first request
    pass

@app.route("/stop", methods=["POST"])
def stop():
    stop_event.set()
    return jsonify({"status": "stopped"})


@app.route("/auth/check")
def auth_check():
    return jsonify(logged_in=session.get("logged_in", False))


def _handle_chat_request(data=None):
    data = data or request.get_json(silent=True) or {}
    user_input = (data.get("message") or "").strip()
    section = (data.get("section") or "Retail Purchases").strip()
    email = session.get("email")
    
    if not email:
        return jsonify({"error": "Not logged in."}), 401
    
    conversation_id = get_next_conversation_id(email, section)

    if not user_input:
        return jsonify({"error": "Message cannot be empty."}), 400

    memory = [{"role": "user", "content": user_input}]
    use_streaming = data.get("stream", True)

    if use_streaming:
        def generate():
            stop_event.clear()
            full_response = []
            for chunk in call_ai_stream(memory, stop_event=stop_event, section=section):
                if stop_event.is_set():
                    yield "data: [INTERRUPTED]\n\n"
                    return
                full_response.append(chunk)
                yield f"data: {chunk}\n\n"
            save_conversation(email, conversation_id, user_input, "".join(full_response))
            yield "data: [DONE]\n\n"
        return Response(stream_with_context(generate()), mimetype="text/event-stream")

    try:
        agent_response, _ = call_ai(memory, section=section)
        save_conversation(email, conversation_id, user_input, agent_response)
        return jsonify({"response": agent_response})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/", methods=["GET", "POST"])
def home():
    if request.method == "POST":
        return _handle_chat_request()
    return render_template("index.html")


@app.route("/chat", methods=["POST"])
def chat():
    return _handle_chat_request()


@app.route("/stream", methods=["POST"])
def stream():
    data = request.get_json(silent=True) or {}
    return _handle_chat_request({"message": data.get("message",""), "stream": True, "section": data.get("section","Retail Purchases")})

@app.route("/ask", methods=["POST"])
def ask():
    return _handle_chat_request({"message": request.get_json(silent=True).get("message", ""), "stream": False})


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(status="logged_out")


if __name__ == "__main__":
    app.run(debug=True)