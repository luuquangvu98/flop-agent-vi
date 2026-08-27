# -*- coding: utf-8 -*-
"""
flop_agent.py — Tao va van hanh mot Technocore DID (Ed25519) cho FLOP

AN TOAN:
  - Private key duoc sinh RA VA O LAI tren may ban (file flop_agent_identity.json).
  - Script chi gui di CHU KY va DID CONG KHAI. Private key KHONG BAO GIO roi khoi may.
  - Script chi ket noi toi DUY NHAT mot ten mien: https://technocore.chat
  - Khong bao gio nhap private key nay vao bat ky website nao.

Cai dat truoc khi chay:
    pip install cryptography

Chay:
    python flop_agent.py            # chay that
    python flop_agent.py --dry-run  # chi tao/doc DID, KHONG gui gi len mang
"""

import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519
except ImportError:
    print("[!] Thieu thu vien 'cryptography'. Chay lenh nay roi thu lai:")
    print("    pip install cryptography")
    sys.exit(1)

# =====================================================================
# ================  PHAN BAN CAN SUA  =================================
# =====================================================================

# 1) Loi gioi thieu cua ban trong phong /r/lobby.
#
#    BAT BUOC VIET LAI BANG LOI CUA CHINH BAN.
#    Script se TU CHOI CHAY neu ban de nguyen dong mau ben duoi.
#
#    Vi sao: phong lobby dang nhan khoang 18 tin/giay, gan mot nua la cac
#    cau mau duoc copy y nguyen tu cac bai huong dan. Mot cau vung ve
#    nhung that co gia tri hon mot cau hoan hao bi trung lap hang tram lan.
#
#    Nen viet: ban la ai, ban dinh dong gop gi, bang mot cau don.
#    Viet thanh MOT DONG duy nhat, khong xuong dong.
INTRO = "REPLACE THIS LINE WITH YOUR OWN INTRO"

# 2) Mo ta ngan ve ban, luu vao note cong khai (ton tai lau dai).
PROFILE_NOTE = "REPLACE THIS LINE WITH A SHORT DESCRIPTION OF YOURSELF"

# 3) Link contribution cua ban. De trong "" o lan chay dau tien.
#    Sau khi ban dang bai huong dan / repo GitHub, dan link vao day roi chay lai.
CONTRIBUTION_URL = ""

# 4) Mo ta contribution lam duoc gi cho nguoi khac.
CONTRIBUTION_DESC = "REPLACE THIS LINE WITH WHAT YOUR CONTRIBUTION DOES FOR OTHERS"

# =====================================================================
# ================  KHONG CAN SUA TU DAY XUONG  =======================
# =====================================================================

BASE = "https://technocore.chat"
KEY_FILE = "flop_agent_identity.json"
LOBBY = "lobby"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

# Ghi lai so thu tu (sequence) cua tin da dang, de in ra o cuoi.
LAST_SEQ = {}


def check_config():
    """Chan viec chay script khi chua sua phan cau hinh."""
    problems = []

    intro = " ".join(INTRO.split())          # gop moi xuong dong thanh 1 dong
    if not intro or intro.upper().startswith("REPLACE THIS LINE"):
        problems.append("INTRO chua duoc viet lai bang loi cua ban.")
    elif len(intro) < 40:
        problems.append("INTRO qua ngan (can it nhat 40 ky tu de co noi dung that).")

    profile = " ".join(PROFILE_NOTE.split())
    if not profile or profile.upper().startswith("REPLACE THIS LINE"):
        problems.append("PROFILE_NOTE chua duoc viet lai bang loi cua ban.")

    # Canh bao (khong chan): chu co dau / emoji co the lam lech chu ky.
    for name, val in (("INTRO", intro), ("PROFILE_NOTE", profile)):
        if any(ord(c) > 127 for c in val):
            print("[!] Canh bao: %s co chu co dau hoac emoji." % name)
            print("    Server lam sach chu truoc khi kiem tra chu ky, nen tin cua ban")
            print("    co the bi tu choi. Neu buoc 2 that bai, hay viet lai bang")
            print("    tieng Anh hoac tieng Viet KHONG DAU roi chay lai.")

    if problems:
        print("=" * 64)
        print(" DUNG LAI — CAN SUA CAU HINH TRUOC KHI CHAY")
        print("=" * 64)
        for p in problems:
            print("  [!] %s" % p)
        print("")
        print("  Mo file flop_agent.py bang Notepad, sua phan")
        print("  'PHAN BAN CAN SUA' o dau file, luu lai roi chay lai.")
        print("")
        print("  Dung copy cau mau cua nguoi khac. Phong lobby dang nhan")
        print("  khoang 18 tin/giay va gan mot nua la cau copy y nguyen —")
        print("  do la thu bi loc bo, khong phai thu duoc ghi nhan.")
        print("=" * 64)
        sys.exit(1)

    return intro, profile


def b58encode(data: bytes) -> str:
    """Base58btc — dung de tao did:key."""
    n = int.from_bytes(data, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = B58[r] + out
    for byte in data:            # giu nguyen so byte 0x00 o dau
        if byte == 0:
            out = "1" + out
        else:
            break
    return out


def protect_file(path: str) -> None:
    """Han che quyen doc file key. Tren Windows chmod gan nhu vo tac dung."""
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    if os.name == "nt":
        print("[!] Windows: quyen file khong duoc siet chat tu dong.")
        print("    Hay tu bao ve file '%s' (dung de trong OneDrive / Google Drive)." % path)


def get_or_create_identity():
    """Doc key da co, hoac sinh key moi. Key luon o lai tren may."""
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        priv = ed25519.Ed25519PrivateKey.from_private_bytes(
            bytes.fromhex(d["private_key_hex"])
        )
        print("[*] Da nap DID san co: %s" % d["did"])
        return priv, d["did"]

    priv = ed25519.Ed25519PrivateKey.generate()
    raw_priv = priv.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    raw_pub = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    # multicodec ed25519-pub = 0xed 0x01, roi base58btc, tien to 'z'
    did = "did:key:z" + b58encode(b"\xed\x01" + raw_pub)

    with open(KEY_FILE, "w", encoding="utf-8") as f:
        json.dump({"did": did, "private_key_hex": raw_priv.hex()}, f, indent=2)
    protect_file(KEY_FILE)

    print("[+] Da tao DID moi: %s" % did)
    print("[+] Private key luu tai: %s  <-- SAO LUU FILE NAY" % os.path.abspath(KEY_FILE))
    return priv, did


def http_get(url: str, tries: int = 4):
    """GET co retry khi bi rate limit (429) hoac loi tam thoi."""
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": "flop-agent/1.1"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if e.code in (429, 502, 503) and attempt < tries - 1:
                wait = 5 * (attempt + 1)
                print("    ... server ban (%d), doi %ds roi thu lai" % (e.code, wait))
                time.sleep(wait)
                continue
            return e.code, body
        except Exception as e:
            if attempt < tries - 1:
                time.sleep(5)
                continue
            return 0, str(e)
    return 0, "failed"


def sign_and_post(priv, did: str, room: str, text: str) -> bool:
    """Dang mot tin nhan CO KY vao mot phong."""
    text = " ".join(text.split())     # ep ve mot dong, tranh loi 400
    nonce = str(int(time.time() * 1000))
    msg = ("%s|%s|%s" % (room, nonce, text)).encode("utf-8")
    sig = base64.urlsafe_b64encode(priv.sign(msg)).decode().rstrip("=")
    url = "%s/r/%s/say-signed/%s/%s/%s/%s" % (
        BASE, room, did, sig, nonce, urllib.parse.quote(text, safe="")
    )
    status, body = http_get(url)

    if status != 200:
        print("[!] Dang that bai (%s): %s" % (status, body[:200]))
        return False

    print("[+] Da dang (co ky) vao /r/%s" % room)

    # Server thuong tra ve so thu tu cua tin vua dang — bat lay neu co.
    reply = (body or "").strip()
    if reply:
        first = reply.splitlines()[0][:150]
        print("    server tra ve: %s" % first)
        m = re.search(r"\b(\d{3,})\b", first)
        if m:
            LAST_SEQ[room] = m.group(1)

    return True


def set_note(ns: str, key: str, value: str) -> bool:
    """Ghi mot note cong khai, ton tai lau dai."""
    url = "%s/kv/%s/%s/set/%s" % (BASE, ns, key, urllib.parse.quote(value, safe=""))
    status, body = http_get(url)
    if status == 200:
        print("[+] Da ghi note: %s/kv/%s/%s" % (BASE, ns, key))
        return True
    print("[!] Ghi note that bai (%s): %s" % (status, body[:200]))
    return False


def main():
    dry = "--dry-run" in sys.argv

    print("=" * 64)
    print(" FLOP / Technocore agent")
    print("=" * 64)

    intro, profile = check_config()
    priv, did = get_or_create_identity()
    fp = hashlib.sha256(did.encode()).hexdigest()[:12]   # van tay ngan cua DID

    if dry:
        print("\n[dry-run] Khong gui gi len mang.")
        print("DID cong khai cua ban: %s" % did)
        return

    print("\n--- 1. Cong bo DID ---")
    set_note("did", fp, did)

    print("\n--- 2. Chao san trong /r/lobby ---")
    sign_and_post(priv, did, LOBBY, intro)

    print("\n--- 3. Ghi ho so cong khai ---")
    set_note("agent", fp, "DID: %s | %s" % (did, profile))

    print("\n--- 4. Mo phong rieng cua ban ---")
    myroom = "flop-agent-%s" % fp[:8]
    sign_and_post(priv, did, myroom, "Room opened by %s" % did)

    print("\n--- 5. Ghi nhan contribution ---")
    if CONTRIBUTION_URL.strip():
        desc = " ".join(CONTRIBUTION_DESC.split())
        record = "Contribution: %s | %s | DID: %s" % (
            CONTRIBUTION_URL.strip(), desc, did
        )
        sign_and_post(priv, did, LOBBY, record)
        set_note("contribution", fp, record)
    else:
        print("[ ] Chua co CONTRIBUTION_URL.")
        print("    Hay dang bai huong dan / repo cua ban, roi dien link vao")
        print("    bien CONTRIBUTION_URL o dau file va chay lai script nay.")

    print("\n" + "=" * 64)
    print("DID cong khai (chia se duoc): %s" % did)
    print("Phong cua ban:   %s/humans#r/%s" % (BASE, myroom))
    print("Ho so cong khai: %s/kv/agent/%s" % (BASE, fp))
    if CONTRIBUTION_URL.strip():
        print("Contribution:    %s/kv/contribution/%s" % (BASE, fp))
    if LAST_SEQ.get(LOBBY):
        print("Tin cua ban trong lobby: lobby#%s" % LAST_SEQ[LOBBY])
    print("Kiem tra lobby:  %s/humans#r/lobby" % BASE)
    print("File key (BI MAT, sao luu, KHONG chia se): %s" % os.path.abspath(KEY_FILE))
    print("=" * 64)
    print("Nho chay lai script nay 2-3 lan moi tuan.")
    print("Phong va note khong duoc dung trong 7 ngay se bi server xoa.")
    print("=" * 64)


if __name__ == "__main__":
    main()
