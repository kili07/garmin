#!/usr/bin/env python3
"""App-Icons für die Garmin-Übersicht erzeugen: Herz mit Pulslinie, weiß auf #1B1B1B.

Das Herz ist die klassische Herzkurve (x = 16 sin³t, y = 13 cos t − …), gefüllt;
quer hindurch läuft eine Pulszacke in Hintergrundfarbe. Groß zeichnen (SS-fach)
und verkleinern, sonst werden die Kanten stufig. Farbe und Motivgröße stehen
oben und lassen sich in einer Zeile ändern.

Aufruf:  python3 icons/make-icons.py
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

BG = (0x1B, 0x1B, 0x1B, 255)
FG = (0xFF, 0xFF, 0xFF, 255)
SS = 4                      # Überabtastung

# Motivbreite relativ zur Kantenlänge (siehe Bauanleitung 5.14)
ANY_W = 0.45
MASKABLE_W = 0.32

HERE = Path(__file__).resolve().parent


def heart(cx, cy, w, steps=400):
    """Herzkurve als Polygon, Breite w, optisch mittig um (cx, cy)."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((x, -y))
    # Die Kurve ist 32 breit und reicht von −12 (oben) bis 17 (Spitze); Mitte der Höhe bei 2,5
    k = w / 32
    return [(cx + x * k, cy + (y - 2.5) * k) for x, y in pts]


def motif(img, cx, cy, w):
    d = ImageDraw.Draw(img)
    d.polygon(heart(cx, cy, w), fill=FG)
    # Pulszacke quer durchs Herz, etwas über der Mitte
    s = w / 32
    y0 = cy - 1.0 * s
    line = [(-13, 0), (-5, 0), (-2.5, -6), (1, 7), (3.5, -2), (5, 0), (13, 0)]
    pts = [(cx + x * s, y0 + y * s) for x, y in line]
    width = int(w * 0.075)
    d.line(pts, fill=BG, width=width, joint='curve')
    for (x, y) in (pts[0], pts[-1]):
        r = width / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=BG)


def make(size, motif_w, name):
    big = size * SS
    img = Image.new('RGBA', (big, big), BG)
    motif(img, big / 2, big / 2, big * motif_w)
    img = img.resize((size, size), Image.LANCZOS)
    img.convert('RGB').save(HERE / name, optimize=True)
    print('geschrieben:', name)


if __name__ == '__main__':
    make(192, ANY_W, 'icon-192.png')
    make(512, ANY_W, 'icon-512.png')
    make(512, MASKABLE_W, 'icon-maskable-512.png')
