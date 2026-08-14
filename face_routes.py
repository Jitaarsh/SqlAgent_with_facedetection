import base64
from io import BytesIO
import numpy as np
from flask import Blueprint, request, jsonify, session
from PIL import Image
from pymilvus import connections, Collection, FieldSchema, CollectionSchema, DataType, utility
import pymysql
from face_pipeline import get_combined_embedding
import traceback
import hashlib

face_bp = Blueprint("face", __name__, url_prefix="/face")

# ─────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────
MILVUS_COLLECTION_NAME = "user_faces"
MILVUS_DIM = 1024
MILVUS_SCORE_THRESHOLD = 0.6

MYSQL_CONFIG = {
    "host": "localhost",
    "user": "root",
    "password": "admin",  # Update with your MySQL password
    "database": "user_conversation_sqlagent",
}

# ─────────────────────────────────────────────────────────────
# Milvus Collection Management
# ─────────────────────────────────────────────────────────────
def get_collection():
    """Connect to Milvus and get or create user_faces collection"""
    connections.connect("default", host="localhost", port=19530)
    if not utility.has_collection(MILVUS_COLLECTION_NAME):
        fields = [
            FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
            FieldSchema(name="email", dtype=DataType.VARCHAR, max_length=100),
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=MILVUS_DIM),
        ]
        col = Collection(MILVUS_COLLECTION_NAME, CollectionSchema(fields))
        col.create_index("embedding", {
            "index_type": "IVF_FLAT",
            "metric_type": "IP",
            "params": {"nlist": 128}
        })
        print(f"[MILVUS] Created collection: {MILVUS_COLLECTION_NAME}")
    else:
        col = Collection(MILVUS_COLLECTION_NAME)
    col.load()
    return col

def get_mysql_connection():
    """Create and return MySQL connection"""
    return pymysql.connect(**MYSQL_CONFIG)

def hash_password(password):
    """Simple password hashing (use bcrypt in production)"""
    return hashlib.sha256(password.encode()).hexdigest()

# ─────────────────────────────────────────────────────────────
# Registration Route
# ─────────────────────────────────────────────────────────────
@face_bp.route("/register", methods=["POST"])
def register():
    """
    Registration flow:
    1. Receive: name, email, password, crops (list of base64 images)
    2. Insert user into MySQL users table
    3. Generate multiple face embeddings and insert into Milvus
    4. Return success or error
    """
    try:
        body = request.get_json(silent=True)
        if not body:
            return jsonify(status="bad_request", error="No JSON body"), 400

        # Validate required fields
        name = (body.get("name") or "").strip()
        email = (body.get("email") or "").strip()
        password = (body.get("password") or "").strip()
        crops = body.get("crops")

        if not all([name, email, password]) or not isinstance(crops, list) or not crops:
            return jsonify(status="bad_request", error="Missing name, email, password, or crops"), 400

        embeddings = []
        for idx, crop_b64 in enumerate(crops):
            if not isinstance(crop_b64, str):
                continue
            try:
                img_bytes = base64.b64decode(crop_b64)
                face_crop = np.array(Image.open(BytesIO(img_bytes)).convert("RGB"))
                h, w = face_crop.shape[:2]
                if h < 60 or w < 60:
                    print(f"[REGISTER] Face too small in crop {idx}: {h}x{w}")
                    continue
                embedding = get_combined_embedding(face_crop)
                if embedding is not None:
                    embeddings.append(embedding)
            except Exception as e:
                print(f"[REGISTER] Invalid image data for crop {idx}: {str(e)}")
                continue

        if len(embeddings) < 3:
            print(f"[REGISTER] Not enough embeddings for: {email} ({len(embeddings)}/5)")
            return jsonify(status="embedding_failed", message="Could not get enough face embeddings"), 400

        print(f"[REGISTER] Processing: {email}, valid embeddings: {len(embeddings)}")

        # Insert into MySQL users table
        try:
            conn = get_mysql_connection()
            cursor = conn.cursor()
            password_hash = hash_password(password)
            
            insert_query = "INSERT INTO users (name, email, password) VALUES (%s, %s, %s)"
            cursor.execute(insert_query, (name, email, password_hash))
            conn.commit()
            print(f"[REGISTER] User inserted into MySQL: {email}")
            
            cursor.close()
            conn.close()
        except pymysql.IntegrityError:
            print(f"[REGISTER] Email already exists: {email}")
            return jsonify(status="email_exists", error="Email already registered"), 409
        except Exception as e:
            print(f"[REGISTER] MySQL error: {str(e)}")
            return jsonify(status="db_error", error=f"Database error: {str(e)}"), 500

        # Compute averaged embedding
        mean_emb = np.mean(embeddings, axis=0)
        mean_emb = mean_emb / np.linalg.norm(mean_emb)

        # Insert into Milvus user_faces collection (single averaged embedding)
        try:
            col = get_collection()
            col.insert([[email], [mean_emb.tolist()]])
            col.flush()
            print(f"[REGISTER] Averaged face embedding inserted into Milvus for: {email}")
        except Exception as e:
            print(f"[REGISTER] Milvus error: {str(e)}")
            # Rollback MySQL if Milvus insert failed
            try:
                conn = get_mysql_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM users WHERE email = %s", (email,))
                conn.commit()
                cursor.close()
                conn.close()
                print(f"[REGISTER] Rolled back MySQL user for: {email}")
            except Exception as rollback_err:
                print(f"[REGISTER] Rollback failed: {str(rollback_err)}")
            return jsonify(status="milvus_error", error=f"Face storage error: {str(e)}"), 500

        print(f"[REGISTER] Successfully registered user: {email}")
        return jsonify(status="registered", email=email, name=name), 200

    except Exception as e:
        print(f"[REGISTER ERROR] {str(e)}")
        traceback.print_exc()
        return jsonify(status="error", error=str(e)), 500


# ─────────────────────────────────────────────────────────────
# Identify Route (Face Recognition without email)
# ─────────────────────────────────────────────────────────────
@face_bp.route("/identify", methods=["POST"])
def identify():
    body = request.get_json(silent=True)
    if not body or "crop" not in body:
        return jsonify(status="bad_request"), 400

    img_bytes = base64.b64decode(body["crop"])
    face_crop = np.array(Image.open(BytesIO(img_bytes)).convert("RGB"))

    h, w = face_crop.shape[:2]
    if h < 60 or w < 60:
        return jsonify(status="face_too_small"), 200

    embedding = get_combined_embedding(face_crop)
    if embedding is None:
        return jsonify(status="embedding_failed"), 200

    # Step 1 — search Milvus
    col = get_collection()
    results = col.search(
        data=[embedding.tolist()],
        anns_field="embedding",
        param={"metric_type": "IP", "params": {"nprobe": 10}},
        limit=1,
        output_fields=["email"]
    )

    if not results or not results[0]:
        return jsonify(status="not_found", message="No face match found"), 200

    top = results[0][0]
    score = top.score

    # With normalized embeddings, IP scores above 0.65 are the valid match range.
    if score < 0.65:
        return jsonify(status="not_found", message="Face not recognized"), 200

    matched_email = top.entity.get("email")
    if not matched_email:
        return jsonify(status="not_found", message="No email in record"), 200

    # Step 3 — verify user actually exists in MySQL
    conn = cursor = None
    try:
        conn = get_mysql_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name, email FROM users WHERE email = %s", 
            (matched_email,)
        )
        row = cursor.fetchone()
    finally:
        if cursor: cursor.close()
        if conn: conn.close()

    # Step 4 — if not in MySQL, reject even if Milvus matched
    if not row:
        return jsonify(status="not_found", message="User not registered"), 200

    name  = row[0]
    email = row[1]

    # Step 5 — only NOW set session
    session["email"]     = email
    session["logged_in"] = True

    return jsonify(
        status="identified",
        email=email,
        name=name,
        score=round(float(score), 4)
    )


# ─────────────────────────────────────────────────────────────
# Login Route
# ─────────────────────────────────────────────────────────────
@face_bp.route("/login/basic", methods=["POST"])
def login_basic():
    """Only validate the email/password pair from MySQL."""
    try:
        body = request.get_json(silent=True)
        if not body:
            return jsonify(status="bad_request", error="No JSON body"), 400

        email = (body.get("email") or "").strip()
        password = (body.get("password") or "").strip()

        if not email or not password:
            return jsonify(status="bad_request", error="Missing email or password"), 400

        conn = get_mysql_connection()
        cursor = conn.cursor()
        password_hash = hash_password(password)
        query = "SELECT name FROM users WHERE email = %s AND password = %s"
        cursor.execute(query, (email, password_hash))
        result = cursor.fetchone()
        cursor.close()
        conn.close()

        if not result:
            return jsonify(status="auth_failed", error="Invalid email or password"), 401

        return jsonify(status="auth_success", email=email, name=result[0]), 200
    except Exception as e:
        print(f"[LOGIN BASIC ERROR] {str(e)}")
        traceback.print_exc()
        return jsonify(status="error", error=str(e)), 500


@face_bp.route("/login", methods=["POST"])
def login():
    """
    Login flow:
    1. Receive: email, password, face crop (base64)
    2. Step 1: Check email+password against MySQL users table
    3. Step 2: Generate face embedding from webcam frame
    4. Step 3: Search Milvus user_faces for top 1 result
    5. Step 4: Verify:
       - Returned email matches input email
       - Similarity score > 0.65
    6. Return success or specific error
    """
    try:
        body = request.get_json(silent=True)
        if not body:
            return jsonify(status="bad_request", error="No JSON body"), 400

        email = (body.get("email") or "").strip()
        password = (body.get("password") or "").strip()
        crop_b64 = body.get("crop")

        if not all([email, password, crop_b64]):
            return jsonify(status="bad_request", error="Missing email, password, or crop"), 400

        print(f"[LOGIN] Attempting login: {email}")

        try:
            conn = get_mysql_connection()
            cursor = conn.cursor()
            password_hash = hash_password(password)
            query = "SELECT name FROM users WHERE email = %s AND password = %s"
            cursor.execute(query, (email, password_hash))
            result = cursor.fetchone()
            cursor.close()
            conn.close()

            if not result:
                print(f"[LOGIN] Invalid email/password: {email}")
                return jsonify(status="auth_failed", error="Invalid email or password"), 401

            user_name = result[0]
            print(f"[LOGIN] MySQL check passed for: {email}")

        except Exception as e:
            print(f"[LOGIN] MySQL error: {str(e)}")
            return jsonify(status="db_error", error=f"Database error: {str(e)}"), 500

        try:
            img_bytes = base64.b64decode(crop_b64)
            face_crop = np.array(Image.open(BytesIO(img_bytes)).convert("RGB"))
            h, w = face_crop.shape[:2]
            if h < 60 or w < 60:
                print(f"[LOGIN] Face too small: {h}x{w}")
                return jsonify(status="face_too_small", message="Move closer to camera"), 200
        except Exception as e:
            print(f"[LOGIN] Invalid image data: {str(e)}")
            return jsonify(status="bad_request", error=f"Invalid image data: {str(e)}"), 400

        embedding = get_combined_embedding(face_crop)
        if embedding is None:
            print("[LOGIN] Embedding generation failed")
            return jsonify(status="embedding_failed", error="Could not generate face embedding"), 400

        print(f"[LOGIN] Face embedding generated, searching Milvus...")

        try:
            col = get_collection()
            results = col.search(
                data=[embedding.tolist()],
                anns_field="embedding",
                param={"metric_type": "IP", "params": {"nprobe": 10}},
                limit=1,
                expr=f'email == "{email}"',
                output_fields=["email"]
            )

            print(f"[LOGIN] Milvus search results: {results}")

            if not results or not results[0]:
                print("[LOGIN] No face found in Milvus for this user")
                return jsonify(status="face_mismatch", error="Face verification failed"), 401

            top_result = results[0][0]
            matched_email = top_result.entity.get("email")
            similarity_score = top_result.score

            print(f"[LOGIN] Top match - email: {matched_email}, score: {similarity_score}")

            if matched_email != email:
                print(f"[LOGIN] Email mismatch: input={email}, matched={matched_email}")
                return jsonify(status="face_mismatch", error="Face verification failed"), 401

            if similarity_score < 0.65:
                print(f"[LOGIN] Score too low: {similarity_score} < 0.65")
                return jsonify(status="face_mismatch", error="Face verification failed"), 401

            print(f"[LOGIN] ✓ Login successful for: {email}")
            session["email"] = email
            session["logged_in"] = True
            return jsonify(
                status="login_success",
                email=email,
                name=user_name,
                score=round(float(similarity_score), 4)
            ), 200

        except Exception as e:
            print(f"[LOGIN] Milvus error: {str(e)}")
            traceback.print_exc()
            return jsonify(status="milvus_error", error=f"Search error: {str(e)}"), 500

    except Exception as e:
        print(f"[LOGIN ERROR] {str(e)}")
        traceback.print_exc()
        return jsonify(status="error", error=str(e)), 500
