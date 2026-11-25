import hashlib, io, sys
from PIL import Image
with Image.open(io.BytesIO(sys.stdin.buffer.read(24*1024*1024+1))) as image:
    if image.width*image.height > 4_000_000 or image.width <= 0 or image.height <= 0:
        raise ValueError("图片超过 400 万像素")
    print(str(image.size)+":"+hashlib.sha256(image.convert("RGBA").tobytes()).hexdigest())
