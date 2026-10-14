"""Read image pixels or render one document page; never modify source files."""
import base64
import io
import json
import os
import pathlib
import subprocess
import sys
from PIL import Image

Image.MAX_IMAGE_PIXELS = 20_000_000
source = pathlib.Path(sys.argv[1])
page = int(sys.argv[2]) if len(sys.argv) > 2 else None

try:
    if page is None:
        with Image.open(source) as opened:
            if opened.width * opened.height > 20_000_000:
                raise ValueError("Image exceeds the 20 megapixel conversion limit.")
            image = opened.convert("RGBA" if "A" in opened.getbands() else "RGB")
    else:
        import pypdfium2 as pdfium
        if page < 1:
            raise ValueError("page must be at least 1.")
        pdf_path = source
        if source.suffix.lower() != ".pdf":
            base = pathlib.Path(os.environ["DOCUMENT_WORK_DIR"])
            output = base / "pages"
            output.mkdir()
            profile = (base / "profile").as_uri()
            soffice = os.environ.get("LOCAL_FILE_READER_LIBREOFFICE", r"C:\Program Files\LibreOffice\program\soffice.exe")
            subprocess.run([soffice, "-env:UserInstallation=" + profile, "--headless", "--nologo",
                            "--nodefault", "--convert-to", "pdf", "--outdir", str(output), str(source)],
                           timeout=25, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            converted = list(output.glob("*.pdf"))
            if len(converted) != 1:
                raise ValueError("Converter did not produce a PDF.")
            pdf_path = converted[0]
        with pdfium.PdfDocument(pdf_path) as pdf:
            if page > len(pdf):
                raise ValueError("Requested page does not exist.")
            document_page = pdf[page - 1]
            width, height = document_page.get_size()
            bitmap = document_page.render(scale=min(1.5, 4096 / max(width, height)))
            try:
                image = bitmap.to_pil().copy()
            finally:
                bitmap.close()
                document_page.close()
    image.thumbnail((4096, 4096))
    target = io.BytesIO()
    image.save(target, format="PNG")
    data = target.getvalue()
    if len(data) > 10 * 1024 * 1024:
        raise ValueError("Rendered image exceeds the 10 MiB response limit.")
    print(json.dumps({"data": base64.b64encode(data).decode("ascii"), "mimeType": "image/png",
                      "width": image.width, "height": image.height, "page": page}))
except Exception as error:
    print(json.dumps({"error": str(error)}))
    sys.exit(1)
