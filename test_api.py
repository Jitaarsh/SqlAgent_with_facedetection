#!/usr/bin/env python3
"""Test the Face Recognition API"""

import base64
import json
import requests
from PIL import Image
import numpy as np

BASE_URL = "http://localhost:5000"

def create_test_image():
    """Create a simple test image of random face-like data"""
    # Create a random image that looks like a face crop
    img_data = np.random.randint(0, 255, (200, 160, 3), dtype=np.uint8)
    img = Image.fromarray(img_data, 'RGB')
    
    # Save to bytes
    from io import BytesIO
    buffer = BytesIO()
    img.save(buffer, format='JPEG', quality=90)
    return base64.b64encode(buffer.getvalue()).decode('utf-8')

def test_register():
    """Test the register endpoint"""
    print("\n=== Testing REGISTER ===")
    
    crop_data = create_test_image()
    payload = {
        "name": "Test User",
        "crop": crop_data
    }
    
    print(f"Sending image (size: {len(crop_data)} chars)...")
    response = requests.post(f"{BASE_URL}/face/register", json=payload)
    print(f"Status: {response.status_code}")
    print(f"Response: {response.json()}")
    
    return response.status_code == 200

def test_login():
    """Test the login endpoint"""
    print("\n=== Testing LOGIN ===")
    
    crop_data = create_test_image()
    payload = {
        "crop": crop_data
    }
    
    print(f"Sending image (size: {len(crop_data)} chars)...")
    response = requests.post(f"{BASE_URL}/face/login", json=payload)
    print(f"Status: {response.status_code}")
    print(f"Response: {response.json()}")
    
    return response.status_code == 200

if __name__ == "__main__":
    try:
        test_register()
        test_login()
        print("\n✅ All tests completed!")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
