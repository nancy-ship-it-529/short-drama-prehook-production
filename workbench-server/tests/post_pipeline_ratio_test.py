from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
from unittest.mock import patch


module_path = Path(__file__).resolve().parents[1] / "scripts" / "post_pipeline.py"
sys.path.insert(0, str(module_path.parent))
spec = spec_from_file_location("post_pipeline", module_path)
module = module_from_spec(spec)
spec.loader.exec_module(module)

for ratio, dimensions in {"9:16": "720:1280", "16:9": "1280:720", "1:1": "720:720"}.items():
    commands = []
    with patch.object(module, "has_audio", return_value=True), patch.object(module, "run", side_effect=commands.append):
        module.normalize(Path("source.mp4"), Path("output.mp4"), ratio=ratio)
    filter_value = commands[0][commands[0].index("-vf") + 1]
    assert f"scale={dimensions}" in filter_value, (ratio, filter_value)
    assert f"pad={dimensions}" in filter_value, (ratio, filter_value)

print("Post-pipeline ratio checks passed")
