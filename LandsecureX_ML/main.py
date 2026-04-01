from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
import io
from PIL import Image
from skimage.metrics import structural_similarity as ssim

app = FastAPI(title="LandSecureX ML Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def process_image(file):
    image = Image.open(io.BytesIO(file))
    return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)

@app.get("/")
def read_root():
    return {"status": "ML Engine Online"}

def align_images(img1, img2):
    """
    Aligns img2 to img1 using ORB feature matching (Digital Image Registration).
    Essential for 'Real-Time' efficiency to handle slight map offsets.
    """
    gray1 = cv2.cvtColor(img1, cv2.COLOR_BGR2GRAY)
    gray2 = cv2.cvtColor(img2, cv2.COLOR_BGR2GRAY)

    # 1. Detect ORB features
    orb = cv2.ORB_create(500)
    kp1, des1 = orb.detectAndCompute(gray1, None)
    kp2, des2 = orb.detectAndCompute(gray2, None)

    # 2. Match features using BFMatcher
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = matcher.match(des1, des2)
    matches = sorted(matches, key=lambda x: x.distance)

    # 3. Extract location of good matches
    points1 = np.zeros((len(matches), 2), dtype=np.float32)
    points2 = np.zeros((len(matches), 2), dtype=np.float32)

    for i, match in enumerate(matches):
        points1[i, :] = kp1[match.queryIdx].pt
        points2[i, :] = kp2[match.trainIdx].pt

    # 4. Find homography and warp image
    if len(matches) > 10:
        h, mask = cv2.findHomography(points2, points1, cv2.RANSAC)
        height, width, channels = img1.shape
        img2_aligned = cv2.warpPerspective(img2, h, (width, height))
        return img2_aligned, True
    return img2, False

def detect_structural_features(image):
    """
    Extracts architectural signatures using selective denoising to destroy
    soft/organic field variations and highlight rigid, man-made structures.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # 0. Denoise dirt textures while keeping building edges sharp
    filtered = cv2.bilateralFilter(gray, 9, 75, 75)
    
    # 1. Architectural Lines & Contours
    edges = cv2.Canny(filtered, 40, 120)
    
    # Morphological closing to seal building walls
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed_edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)
    
    lines = cv2.HoughLinesP(closed_edges, 1, np.pi/180, threshold=30, minLineLength=15, maxLineGap=15)
    line_count = len(lines) if lines is not None else 0

    # 1b. Polygons (Rigid Buildings)
    contours, _ = cv2.findContours(closed_edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    buildings = 0
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if 50 < area < 5000:  # Size of a reasonable building footprint
            approx = cv2.approxPolyDP(cnt, 0.04 * cv2.arcLength(cnt, True), True)
            if 4 <= len(approx) <= 6:  # Squares, rectangles, tight clusters
                buildings += 1

    # 2. Architectural Corners (Use filtered image to ignore dirt noise)
    corners = cv2.cornerHarris(filtered, 2, 3, 0.04)
    corner_count = np.sum(corners > 0.005 * corners.max())

    # 3. Laplacian Variance 
    variance = cv2.Laplacian(filtered, cv2.CV_64F).var()

    return line_count, corner_count, variance, buildings

@app.post("/detect")
async def detect_change(
    base_image: UploadFile = File(...),
    current_image: UploadFile = File(...)
):
    # Load and Prepare
    img1 = process_image(await base_image.read())
    img2 = process_image(await current_image.read())
    img1 = cv2.resize(img1, (600, 600))
    img2 = cv2.resize(img2, (600, 600))

    # STAGE 1: ALIGNMENT
    img2, aligned = align_images(img1, img2)

    # STAGE 2: VISION ANALYSIS
    gray1 = cv2.cvtColor(img1, cv2.COLOR_BGR2GRAY)
    gray2 = cv2.cvtColor(img2, cv2.COLOR_BGR2GRAY)
    (ssim_score, _) = ssim(gray1, gray2, full=True)

    lines1, corners1, var1, bld1 = detect_structural_features(img1)
    lines2, corners2, var2, bld2 = detect_structural_features(img2)

    # STAGE 3: WEIGHTED FORENSIC SCORING
    # The golden rule: "Positive Structural Gain". Color/season changes DO NOT overrule structural evidence.
    line_gain = max(0, lines2 - lines1)
    corner_gain = max(0, corners2 - corners1)
    building_gain = max(0, bld2 - bld1)

    # Structural components carry immense weight for rigid man-made objects
    score_lines = line_gain * 3
    score_corners = corner_gain / 5
    score_buildings = building_gain * 40 # Heavily flags actual rectangles/buildings

    # SSIM evaluates overall layout, but is only factored in IF there's structural gain
    score_ssim = 0
    if (score_lines + score_corners + score_buildings) > 10:
        score_ssim = max(0, (0.85 - ssim_score) * 100)
    elif ssim_score < 0.55: # Extreme land destruction (e.g. massive quarrying)
        score_ssim = max(0, (0.75 - ssim_score) * 50)

    final_decision_score = score_ssim + score_lines + score_corners + score_buildings

    # DETECTION LOGIC: 
    # Must cross the rigid evidence threshold
    is_encroachment = final_decision_score > 45

    confidence = min(100, int((final_decision_score / 150) * 100))

    return {
        "change_detected": bool(is_encroachment),
        "change_percentage": confidence,
        "similarity_score": round(ssim_score, 4),
        "structural_score": int(final_decision_score),
        "debug_stats": {
            "new_lines": int(line_gain),
            "new_corners": int(corner_gain),
            "new_buildings": int(building_gain)
        },
        "alignment_status": "LOCKED" if aligned else "COARSE",
        "method": "Morphological-Rigid-Body"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
