import numpy as np
from scipy.ndimage import rotate as scipy_rotate
from facenet_pytorch import InceptionResnetV1
import torch
from torchvision import transforms
from PIL import Image

# ── FaceNet ───────────────────────────────────────────────────
facenet = InceptionResnetV1(pretrained='vggface2').eval()

facenet_transform = transforms.Compose([
    transforms.ToPILImage(),
    transforms.Resize((160, 160)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5])
])

# ── Landmark indices ──────────────────────────────────────────
LEFT_EYE    = 33
RIGHT_EYE   = 263
NOSE_TIP    = 1
LEFT_CHEEK  = 234
RIGHT_CHEEK = 454

FACE_OVAL = [9, 337, 296, 331, 283, 250, 388, 355, 453, 322, 360,
             287, 396, 364, 378, 377, 399, 376, 151, 147, 175, 148,
             149, 135, 171, 57, 131, 92, 233, 126, 161, 20, 53,
             102, 66, 108]

# ── Align & Crop ──────────────────────────────────────────────
def align_and_crop(frame, landmarks, h, w, base_padding=10):
    left_eye  = np.array([landmarks[LEFT_EYE].x  * w, landmarks[LEFT_EYE].y  * h])
    right_eye = np.array([landmarks[RIGHT_EYE].x * w, landmarks[RIGHT_EYE].y * h])

    dx    = right_eye[0] - left_eye[0]
    dy    = right_eye[1] - left_eye[1]
    angle = np.degrees(np.arctan2(dy, dx))

    aligned = scipy_rotate(frame, -angle, reshape=False)

    nose_x        = landmarks[NOSE_TIP].x  * w
    left_cheek_x  = landmarks[LEFT_CHEEK].x  * w
    right_cheek_x = landmarks[RIGHT_CHEEK].x * w
    face_width    = right_cheek_x - left_cheek_x

    nose_offset  = abs(nose_x - (left_cheek_x + face_width / 2))
    turn_ratio   = min(nose_offset / (face_width / 2 + 1e-6), 1.0)
    side_padding = int(turn_ratio * 60)

    oval_x = [landmarks[i].x * w for i in FACE_OVAL]
    oval_y = [landmarks[i].y * h for i in FACE_OVAL]

    if nose_x < (left_cheek_x + face_width / 2):
        x1 = max(0, int(min(oval_x)) - base_padding)
        x2 = min(w, int(max(oval_x)) + base_padding + side_padding)
    else:
        x1 = max(0, int(min(oval_x)) - base_padding - side_padding)
        x2 = min(w, int(max(oval_x)) + base_padding)

    y1 = max(0, int(min(oval_y)) - base_padding)
    y2 = min(h, int(max(oval_y)) + base_padding)

    return aligned[y1:y2, x1:x2], (x1, y1, x2, y2)

# ── FaceNet embedding ─────────────────────────────────────────
def get_facenet_embedding(face_crop):
    if face_crop.size == 0 or face_crop.shape[0] < 10 or face_crop.shape[1] < 10:
        return None
    tensor = facenet_transform(face_crop).unsqueeze(0)
    with torch.no_grad():
        emb = facenet(tensor)
    emb = emb[0].numpy()
    emb = emb / np.linalg.norm(emb)
    return emb  # 512-dim

# ── ArcFace embedding placeholder ──────────────────────────────
def get_arcface_embedding(face_crop):
    return None

# ── Combined 1024-dim embedding ───────────────────────────────
def get_combined_embedding(face_crop):
    if face_crop.size == 0 or face_crop.shape[0] < 10 or face_crop.shape[1] < 10:
        return None

    emb1 = get_facenet_embedding(face_crop)
    emb2 = get_facenet_embedding(face_crop[:, ::-1, :])

    if emb1 is None or emb2 is None:
        return None

    combined = np.concatenate([emb1, emb2])
    return combined / np.linalg.norm(combined)