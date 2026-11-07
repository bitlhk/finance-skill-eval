"""Isolated real meetingroom service with test-only reset/capture controls.

No fixtures replace the original service's handlers or permissions. These local
controls are only deployed in the explicitly named acceptance container.
"""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, '/source')
os.chdir('/source')
from services.meetingroom import server as original
from fastapi import HTTPException
from fastapi.responses import FileResponse

app = original.app
INITIAL = json.loads(original.DATA_FILE.read_text(encoding='utf-8'))
image_path = Path('/acceptance/business/uploads/receipt.png')
if not image_path.exists():
    import uuid
    from PIL import Image, ImageDraw, ImageFont
    image_path.parent.mkdir(parents=True, exist_ok=True)
    code = 'ZX-' + uuid.uuid4().hex[:8].upper()
    picture = Image.new('RGB', (1000, 650), 'white')
    draw = ImageDraw.Draw(picture)
    font = ImageFont.load_default(size=50)
    draw.text((50, 50), 'RECEIPT ' + code, font=font, fill='black')
    draw.text((50, 150), 'TOTAL 128.50', font=font, fill='black')
    draw.ellipse((80, 300, 280, 500), fill='red')
    draw.rectangle((420, 300, 780, 500), fill='blue')
    picture.save(image_path)
    Path('/acceptance/business/vision-gt.json').write_text(json.dumps({'code': code, 'total': '128.50'}), encoding='utf-8')


@app.get('/fixture/image.png')
def image():
    return FileResponse('/acceptance/business/uploads/receipt.png', media_type='image/png')


@app.get('/fixture/state')
def state():
    with original.store_lock:
        return json.loads(original.DATA_FILE.read_text(encoding='utf-8'))


@app.post('/fixture/state')
def restore(value: dict):
    with original.store_lock:
        target = value.get('state', INITIAL)
        # Validate through the original service's own data models before writing.
        rooms = {r['roomId']: original.Room(**r) for r in target['rooms']}
        orders = {o['roomOrderId']: original.Order(**o) for o in target['orders']}
        permissions = {p['userId']: original.Permission(**p) for p in target['permissions']}
        employees = {e['employeeId']: original.Employee(**e) for e in target['employees']}
        original.store.rooms, original.store.orders = rooms, orders
        original.store.permissions, original.store.employees = permissions, employees
        original.store.save()
        return target
