import urllib.request
import re
import os

import base64

cm_ids = ['wp', 'wn', 'wb', 'wr', 'wq', 'wk', 'bp', 'bn', 'bb', 'br', 'bq', 'bk']

sprite_content = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40" style="display: none;">\n'

for p in cm_ids:
    url = f"https://raw.githubusercontent.com/GiorgioMegrelli/chess.com-boards-and-pieces/master/pieces/neo/{p}.png"
    try:
        req = urllib.request.urlopen(url)
        png_data = req.read()
        b64 = base64.b64encode(png_data).decode('ascii')
        
        # Embed PNG using <image> inside <g id="...">
        sprite_content += f'  <g id="{p}">\n    <image width="40" height="40" href="data:image/png;base64,{b64}"></image>\n  </g>\n'
    except Exception as e:
        print(f"Failed to fetch {p}: {e}")

sprite_content += '</svg>'

os.makedirs('frontend/assets/pieces', exist_ok=True)
with open('frontend/assets/pieces/neo.svg', 'w') as f:
    f.write(sprite_content)

print("Created neo.svg sprite!")

# Also download markers.svg and arrows.svg so we can serve assets locally
extensions = {
    'markers': 'https://raw.githubusercontent.com/shaack/cm-chessboard/master/assets/extensions/markers/markers.svg',
    'arrows': 'https://raw.githubusercontent.com/shaack/cm-chessboard/master/assets/extensions/arrows/arrows.svg'
}

for ext, url in extensions.items():
    os.makedirs(f'frontend/assets/extensions/{ext}', exist_ok=True)
    try:
        req = urllib.request.urlopen(url)
        with open(f'frontend/assets/extensions/{ext}/{ext}.svg', 'wb') as f:
            f.write(req.read())
        print(f"Downloaded {ext}.svg!")
    except Exception as e:
        print(f"Failed to download {ext}.svg: {e}")
