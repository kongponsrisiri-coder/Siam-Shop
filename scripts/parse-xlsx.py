#!/usr/bin/env python3
# Parse the supplier price-list spreadsheets into clean product JSON for import.
# Stdlib only (xlsx = zip of XML). Output: scripts/products.json
#
#   python3 scripts/parse-xlsx.py
import zipfile, re, json, os, xml.etree.ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE = re.compile(r'^\d{4,}-[A-Z]$')

def col_idx(ref):
    s = re.match(r'([A-Z]+)', ref).group(1); n = 0
    for ch in s: n = n * 26 + (ord(ch) - 64)
    return n - 1

def read(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')):
            shared.append(''.join(t.text or '' for t in si.iter(NS + 't')))
    sheet = sorted(n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml', n))[0]
    rows = []
    for row in ET.fromstring(z.read(sheet)).iter(NS + 'row'):
        cells = {}
        for c in row.findall(NS + 'c'):
            t, v, isv = c.get('t'), c.find(NS + 'v'), c.find(NS + 'is')
            if t == 's' and v is not None: val = shared[int(v.text)]
            elif t == 'inlineStr' and isv is not None: val = ''.join(x.text or '' for x in isv.iter(NS + 't'))
            elif v is not None: val = v.text
            else: val = ''
            cells[col_idx(c.get('r'))] = val
        rows.append([cells.get(i, '') for i in range(max(cells) + 1)] if cells else [])
    return rows

def clean_name(s):
    s = re.sub(r'\s+', ' ', str(s).strip())
    # Title-case but keep size tokens like 5KG / 10X1KG / 400G readable
    out = []
    for w in s.split(' '):
        out.append(w if re.search(r'\d', w) else w.capitalize())
    return ' '.join(out)

def price_of(x):
    try: return round(float(x), 2)
    except: return None

def base(code):  # strip the -C / -U suffix so case+unit collapse to one product
    return re.sub(r'-[A-Z]$', '', code)

# base_code -> product; prefer the -U (single unit) variant when both exist
products = {}
def add(code, name, price, category, unit):
    if not code or price is None or not name: return
    b = base(code)
    prefer_unit = code.endswith('-U')
    if b in products and not prefer_unit:
        return  # keep existing (don't overwrite a -U with a -C)
    products[b] = {'sku': code, 'name': clean_name(name), 'price': price,
                   'category': category, 'unit': unit}

def unit_from_note(note, code):
    n = str(note).lower()
    if 'kg' in n: return 'kg'
    if 'pack' in n: return 'pack'
    return 'each' if code.endswith('-U') else 'case'

# 1) Frozen — [code, desc, price, cat]
for r in read(os.path.join(ROOT, 'Frozen products.xlsx'))[1:]:
    if len(r) >= 3 and CODE.match(str(r[0]).strip()):
        add(r[0].strip(), r[1], price_of(r[2]), 'Frozen', 'each' if r[0].strip().endswith('-U') else 'case')

# 2) Local Fresh Vegetable — [_, code, desc, price, cat]
for r in read(os.path.join(ROOT, 'Local Fresh Vegetable.xlsx'))[1:]:
    if len(r) >= 4 and CODE.match(str(r[1]).strip()):
        add(r[1].strip(), r[2], price_of(r[3]), 'Fresh Vegetables', 'case')

# 3) RT Fresh — [_, code, desc, price, cat, note]
for r in read(os.path.join(ROOT, 'RT Fresh Product .xlsx'))[1:]:
    if len(r) >= 4 and CODE.match(str(r[1]).strip()):
        name = str(r[2])
        up = name.upper()
        if 'TOFU' in up: cat = 'Vegetarian Food'
        elif any(k in up for k in ('HO FUN', 'WON TON', 'NOODLE')): cat = 'Rice, Noodles & Flour'
        else: cat = 'Fresh Vegetables'
        note = r[5] if len(r) > 5 else ''
        add(r[1].strip(), name, price_of(r[3]), cat, unit_from_note(note, r[1].strip()))

# 4) RS Dry & Non Food — [_, code, desc, price] with section headers
HEADER_MAP = {
    'RICE': 'Rice, Noodles & Flour', 'COCONUT MILK': 'Sauces & Seasonings',
    'NOODLE & RICE PEPPER': 'Rice, Noodles & Flour', 'CURRY PASTE': 'Curry Paste & Chilli Products',
    'FISH SAUCE AND OYSTER SAUCE': 'Sauces & Seasonings', 'SOY SAUCE': 'Sauces & Seasonings',
    'OTHER SAUCE': 'Sauces & Seasonings', 'CANNED & TINNED': 'Canned & Tinned',
    'SUGAR &SALT': 'Sauces & Seasonings', 'CONDEMENTS': 'Sauces & Seasonings',
    'FLOUR &BREAD CRUMB': 'Rice, Noodles & Flour', 'DRIED HERB AND, NUT AND SEED': 'Dried Herbs, Nuts & Seeds',
    'PRESERVED PRODUCT': 'Preserved Fruits & Vegetables', 'OTHER DRIED PRODUCT': 'Dried Herbs, Nuts & Seeds',
    'NON FOOD': 'Household Essentials',
}
current = 'Dried Herbs, Nuts & Seeds'
for r in read(os.path.join(ROOT, 'RS DRY AND NON FOOD PRICE.xlsx'))[1:]:
    codecell = next((str(c).strip() for c in r if CODE.match(str(c).strip())), None)
    if codecell:
        # find desc + price relative to the code column
        ci = next(i for i, c in enumerate(r) if str(c).strip() == codecell)
        desc = r[ci + 1] if len(r) > ci + 1 else ''
        price = price_of(r[ci + 2]) if len(r) > ci + 2 else None
        add(codecell, desc, price, current, 'each' if codecell.endswith('-U') else 'case')
    else:
        txt = ' '.join(str(c).strip() for c in r if str(c).strip())
        if txt:
            current = HEADER_MAP.get(txt.upper(), current)

out = list(products.values())
with open(os.path.join(ROOT, 'scripts', 'products.json'), 'w') as f:
    json.dump(out, f, ensure_ascii=False, indent=0)

from collections import Counter
by_cat = Counter(p['category'] for p in out)
print(f"Parsed {len(out)} products into scripts/products.json")
for cat, n in by_cat.most_common():
    print(f"  {n:4d}  {cat}")
print("\nSamples:")
for p in out[:6]:
    print(f"  - {p['name']}  £{p['price']}  [{p['category']}]  sku={p['sku']} ({p['unit']})")
