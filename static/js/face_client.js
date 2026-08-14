import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

const video  = document.getElementById("video");
const canvas = document.getElementById("canvas");
const status = document.getElementById("status");
const ctx    = canvas.getContext("2d");

const cropCanvas = document.createElement("canvas");
const cropCtx    = cropCanvas.getContext("2d");

let faceLandmarker = null;
let faceDetected = false;
let faceCount = 0;
let lastLandmarks = null;
let resultTimeout = null; // Track if a result message is being shown
let showingResult = false; // Flag to prevent loop from clearing result messages

const FACE_OVAL = [9,337,296,331,283,250,388,355,453,322,360,
                   287,396,364,378,377,399,376,151,147,175,148,
                   149,135,171,57,131,92,233,126,161,20,53,102,66,108];

async function init() {
  status.textContent = "Loading MediaPipe...";
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 2, // detect up to 2 so we can warn about multiple faces
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" }
  });
  video.srcObject = stream;
  video.addEventListener("loadeddata", () => {
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    status.textContent = "Ready — point camera at face.";
    loop();
  });
}

function loop() {
  requestAnimationFrame(loop);

  const now    = performance.now();
  const result = faceLandmarker.detectForVideo(video, now);

  // draw mirrored video
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0);
  ctx.restore();

  // If showing a result message, don't update status
  if (showingResult) {
    return;
  }

  if (!result.faceLandmarks?.length) {
    faceDetected = false;
    faceCount = 0;
    status.textContent = "No face detected.";
    return;
  }

  // Check if multiple faces detected
  if (result.faceLandmarks.length > 1) {
    faceDetected = false;
    faceCount = result.faceLandmarks.length;
    status.textContent = "⚠️ Multiple faces detected — only one face is supported!";
    // Still draw box for first face
    const landmarks = result.faceLandmarks[0];
    const W = canvas.width, H = canvas.height;

    // bbox from FACE_OVAL
    const ovalXs = FACE_OVAL.map(i => landmarks[i].x * W);
    const ovalYs = FACE_OVAL.map(i => landmarks[i].y * H);
    const pad = 10;
    const x1 = Math.max(0, Math.min(...ovalXs) - pad);
    const y1 = Math.max(0, Math.min(...ovalYs) - pad);
    const x2 = Math.min(W, Math.max(...ovalXs) + pad);
    const y2 = Math.min(H, Math.max(...ovalYs) + pad);

    // draw box in red to indicate warning
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth   = 3;
    ctx.strokeRect(W - x2, y1, x2 - x1, y2 - y1);
    return;
  }

  // Single face detected
  faceDetected = true;
  faceCount = 1;
  lastLandmarks = result.faceLandmarks[0];
  status.textContent = "✓ Face detected — ready to register/login";

  const landmarks = result.faceLandmarks[0];
  const W = canvas.width, H = canvas.height;

  // bbox from FACE_OVAL
  const ovalXs = FACE_OVAL.map(i => landmarks[i].x * W);
  const ovalYs = FACE_OVAL.map(i => landmarks[i].y * H);
  const pad = 10;
  const x1 = Math.max(0, Math.min(...ovalXs) - pad);
  const y1 = Math.max(0, Math.min(...ovalYs) - pad);
  const x2 = Math.min(W, Math.max(...ovalXs) + pad);
  const y2 = Math.min(H, Math.max(...ovalYs) + pad);

  // draw box (mirrored for display)
  ctx.strokeStyle = "#00ff00";
  ctx.lineWidth   = 2;
  ctx.strokeRect(W - x2, y1, x2 - x1, y2 - y1);
  // ── LOOP ENDS HERE — no more auto-sending ──────────────────
}

// ── called ONLY by button clicks ──────────────────────────────
window.captureAndSend = async function(mode) {
  const statusEl = document.getElementById("status");
  const name     = document.getElementById("username").value.trim();

  console.log(`[${mode.toUpperCase()}] Starting - faceDetected: ${faceDetected}, hasLandmarks: ${lastLandmarks !== null}`);

  if (mode === "register" && !name) {
    statusEl.textContent = "⚠️ Enter a name first!";
    showingResult = true;
    
    // Clear this temporary message after 3 seconds
    clearTimeout(resultTimeout);
    resultTimeout = setTimeout(() => {
      showingResult = false;
    }, 3000);
    return;
  }

  // Check if a face is detected
  if (!faceDetected || !lastLandmarks) {
    console.warn(`[${mode.toUpperCase()}] Face not detected - faceDetected: ${faceDetected}, faceCount: ${faceCount}`);
    if (faceCount > 1) {
      statusEl.textContent = "⚠️ Multiple faces detected! Remove others from view.";
    } else {
      statusEl.textContent = "⚠️ No face detected! Position your face in the frame.";
    }
    showingResult = true;
    
    // Clear this temporary message after 3 seconds
    clearTimeout(resultTimeout);
    resultTimeout = setTimeout(() => {
      showingResult = false;
    }, 3000);
    return;
  }

  // Extract face crop from video using landmarks
  const W = video.videoWidth;
  const H = video.videoHeight;
  
  console.log(`[${mode.toUpperCase()}] Video dimensions: ${W}x${H}`);
  
  // Calculate bounding box from FACE_OVAL landmarks
  const ovalXs = FACE_OVAL.map(i => lastLandmarks[i].x * W);
  const ovalYs = FACE_OVAL.map(i => lastLandmarks[i].y * H);
  const pad = 10;
  const x1 = Math.max(0, Math.min(...ovalXs) - pad);
  const y1 = Math.max(0, Math.min(...ovalYs) - pad);
  const x2 = Math.min(W, Math.max(...ovalXs) + pad);
  const y2 = Math.min(H, Math.max(...ovalYs) + pad);
  
  console.log(`[${mode.toUpperCase()}] Crop box: (${x1},${y1}) to (${x2},${y2}) = ${x2-x1}x${y2-y1}`);
  
  // Create canvas for face crop
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width  = x2 - x1;
  cropCanvas.height = y2 - y1;
  const cropCtx = cropCanvas.getContext("2d");
  
  // Draw the cropped face from video (not mirrored)
  cropCtx.drawImage(video, x1, y1, x2 - x1, y2 - y1, 0, 0, x2 - x1, y2 - y1);
  
  const crop = cropCanvas.toDataURL("image/jpeg", 0.9).split(",")[1];
  
  console.log(`[${mode.toUpperCase()}] Generated crop image (${crop.length} chars)`);

  const body = mode === "register" ? { crop, name } : { crop };

  statusEl.textContent = mode === "register" ? "🔄 Registering..." : "🔍 Searching...";

  try {
    console.log(`[${mode.toUpperCase()}] Sending request...`);
    const res  = await fetch(`/face/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    console.log(`[${mode.toUpperCase()}] Response:`, data);

    // Set flag to prevent loop from clearing the message
    showingResult = true;

    if (mode === "register") {
      if (data.status === "registered") {
        statusEl.textContent = `✅ SUCCESS! Registered: ${data.name}`;
        // Clear input field
        document.getElementById("username").value = "";
      } else {
        statusEl.textContent = `❌ Registration Failed: ${data.status}`;
      }
    } else {
      if (data.status === "found") {
        statusEl.textContent = `✅ WELCOME! Detected: ${data.name} (match: ${data.score})`;
      } else {
        statusEl.textContent = `❌ Face Not Recognized - No match found`;
      }
    }
    
    // Keep the message visible for 5 seconds, then allow loop to update again
    clearTimeout(resultTimeout);
    resultTimeout = setTimeout(() => {
      showingResult = false;
    }, 5000);
    
  } catch (e) {
    console.error(`[${mode.toUpperCase()}] Error:`, e);
    statusEl.textContent = `❌ Error: ${e.message}`;
    
    showingResult = true;
    clearTimeout(resultTimeout);
    resultTimeout = setTimeout(() => {
      showingResult = false;
    }, 5000);
  }
};

init();