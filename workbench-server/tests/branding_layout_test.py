from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import sys

from PIL import Image, ImageDraw


script = Path(__file__).resolve().parents[1] / "scripts" / "apply_drama_branding.py"
sys.path.insert(0, str(script.parent))
spec = spec_from_file_location("branding", script)
branding = module_from_spec(spec)
spec.loader.exec_module(branding)


def check(with_badge: bool) -> None:
    with TemporaryDirectory(prefix="branding-layout-") as temporary:
        work = Path(temporary)
        frame = Image.new("RGB", (720, 1280))
        drawing = ImageDraw.Draw(frame)
        drawing.rectangle((0, 436, 719, 840), fill=(90, 70, 50))
        if with_badge:
            drawing.polygon([(622, 436), (670, 436), (719, 490), (719, 533)], fill=(220, 20, 20))

        def save_frame(command, cwd=None):
            frame.save(command[-1])

        with patch.object(branding, "run", side_effect=save_frame):
            if not with_badge:
                try:
                    branding.reference_layout(Path("source.mp4"), work)
                except ValueError as error:
                    assert "未在原片右上角识别" in str(error)
                else:
                    raise AssertionError("Missing warning badge must stop packaging")
                return
            width, height, top, overlay = branding.reference_layout(Path("source.mp4"), work)
        assert (width, height, top) == (720, 1280, 436)
        with Image.open(overlay) as image:
            assert image.getpixel((650, 460))[3] == 255
            assert image.getpixel((35, 460))[3] == 0


check(True)
check(False)
print("Branding layout checks passed")
