import os
from PIL import Image, ImageDraw

def create_icon(size):
    # Create image with transparent background
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Red YouTube-style background with rounded corners
    padding = max(1, size // 16)
    radius = size // 4
    rect = [padding, padding, size - padding, size - padding]
    
    # Red background color (YouTube red #FF0000)
    bg_color = (255, 0, 0, 255)
    draw.rounded_rectangle(rect, radius=radius, fill=bg_color)
    
    # Draw white downward download arrow in the center
    cx = size / 2
    cy = size / 2
    scale = size / 32.0
    
    # Arrow stem
    stem_w = 4 * scale
    stem_top = cy - 6 * scale
    stem_bot = cy + 2 * scale
    draw.rectangle([cx - stem_w/2, stem_top, cx + stem_w/2, stem_bot], fill=(255, 255, 255, 255))
    
    # Arrow head (triangle)
    arrow_head = [
        (cx - 7 * scale, cy + 1 * scale),
        (cx + 7 * scale, cy + 1 * scale),
        (cx, cy + 8 * scale)
    ]
    draw.polygon(arrow_head, fill=(255, 255, 255, 255))
    
    # Base bar
    bar_w = 14 * scale
    bar_h = 3 * scale
    bar_y = cy + 10 * scale
    draw.rectangle([cx - bar_w/2, bar_y, cx + bar_w/2, bar_y + bar_h], fill=(255, 255, 255, 255))
    
    return img

os.makedirs("icons", exist_ok=True)
sizes = [16, 48, 128]
for sz in sizes:
    icon_img = create_icon(sz)
    icon_path = f"icons/icon{sz}.png"
    icon_img.save(icon_path, "PNG")
    print(f"Generated {icon_path} ({sz}x{sz})")
