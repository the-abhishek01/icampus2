#!/usr/bin/env python3
"""
iCampus data fetcher & authenticator for WhatsApp bot.
- Authenticates with student.unitedgn.in via BotDetect CAPTCHA
- Fetches student data (attendance, fee, timetable, marks) using session cookie
"""

import sys
import os
import json
import time
import getpass
import re
import requests
from bs4 import BeautifulSoup

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AUTH_DIR = os.path.join(BASE_DIR, 'auth')
SESSION_FILE = os.path.join(BASE_DIR, 'session.txt')
LOGIN_URL = "https://student.unitedgn.in/Login.aspx"
BASE_URL = "https://student.unitedgn.in/"

os.makedirs(AUTH_DIR, exist_ok=True)

DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}

COLLEGE_MAP = {
    'UCEN': 'UCEN',
    'UCRN': 'UCRN',
    'UIMN': 'UIMN',
    'EDUCATION': 'UCEN',
    'ENGINEERING': 'UCRN',
    'MANAGEMENT': 'UIMN'
}


def sanitize_prefix(prefix):
    """Sanitize session prefix for filenames."""
    return re.sub(r'[^A-Za-z0-9_\-]', '_', str(prefix))


def clean_param(val):
    """Strip brackets, quotes, or accidental delimiters from user input."""
    if not val:
        return ''
    return str(val).strip().strip('<>[]()\'"')


def login_init(college, username, password, session_prefix="default"):
    """
    Step 1 of Login:
    - Fetches Login.aspx to acquire ViewState, Validation tokens, and BotDetect captcha
    - Downloads captcha image to auth/captcha_<prefix>.jpeg
    - Saves state to auth/state_<prefix>.json
    - Returns captcha image path on success
    """
    clean_college = clean_param(college).upper()
    college_code = COLLEGE_MAP.get(clean_college, 'UCRN')
    clean_user = clean_param(username)
    clean_pass = clean_param(password)
    safe_prefix = sanitize_prefix(session_prefix)
    captcha_path = os.path.join(AUTH_DIR, f"captcha_{safe_prefix}.jpeg")
    state_path = os.path.join(AUTH_DIR, f"state_{safe_prefix}.json")

    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)

    try:
        resp = session.get(LOGIN_URL, timeout=15)
        if resp.status_code != 200:
            return {"status": "error", "message": f"Failed to load login page: HTTP {resp.status_code}"}

        soup = BeautifulSoup(resp.text, 'html.parser')

        vs = soup.find('input', {'name': '__VIEWSTATE'})
        vg = soup.find('input', {'name': '__VIEWSTATEGENERATOR'})
        ev = soup.find('input', {'name': '__EVENTVALIDATION'})
        vcid = soup.find('input', {'name': 'BDC_VCID_c_login_examplecaptcha'})
        bw = soup.find('input', {'name': 'BDC_BackWorkaround_c_login_examplecaptcha'})
        img = soup.find('img', id=lambda x: x and 'captchaimage' in x.lower())

        if not (vs and img and vcid):
            return {"status": "error", "message": "Failed to parse login form elements."}

        # Resolve Captcha Image URL
        img_src = img['src']
        if not img_src.startswith('http'):
            img_url = requests.compat.urljoin(BASE_URL, img_src)
        else:
            img_url = img_src

        img_resp = session.get(img_url, timeout=15)
        if img_resp.status_code != 200:
            return {"status": "error", "message": "Failed to download CAPTCHA image."}

        with open(captcha_path, 'wb') as f:
            f.write(img_resp.content)

        # BotDetect requires get=p request to prepare validation state
        p_url = img_url.replace('get=image', 'get=p')
        session.get(p_url, timeout=10)

        # Call script-include if present
        script_m = soup.find('script', src=lambda x: x and 'script-include' in x)
        if script_m:
            inc_url = requests.compat.urljoin(BASE_URL, script_m['src'])
            session.get(inc_url, timeout=10)

        session_cookie = session.cookies.get('ASP.NET_SessionId', '')

        state_data = {
            'college': college_code,
            'username': clean_user,
            'password': clean_pass,
            'session_id': session_cookie,
            'cookies': session.cookies.get_dict(),
            'viewstate': vs['value'],
            'generator': vg['value'] if vg else '',
            'eventvalidation': ev['value'] if ev else '',
            'bdc_vcid': vcid['value'],
            'bdc_back': bw['value'] if bw else '0',
            'captcha_path': captcha_path,
            'created_at': time.time()
        }

        with open(state_path, 'w') as f:
            json.dump(state_data, f)

        return {
            "status": "ok",
            "captcha_path": captcha_path,
            "college": college_code,
            "username": clean_user,
            "session_id": session_cookie
        }

    except Exception as e:
        return {"status": "error", "message": f"Exception during login initialization: {str(e)}"}


def login_submit(captcha_code, session_prefix="default"):
    """
    Step 2 of Login:
    - Loads state saved by login_init
    - Submits credentials, ViewState, and Captcha code
    - Validates login response and saves authenticated session to session.txt
    """
    safe_prefix = sanitize_prefix(session_prefix)
    state_path = os.path.join(AUTH_DIR, f"state_{safe_prefix}.json")
    captcha_path = os.path.join(AUTH_DIR, f"captcha_{safe_prefix}.jpeg")

    if not os.path.exists(state_path):
        return {"status": "error", "message": "No active login session found. Please start login again."}

    try:
        with open(state_path, 'r') as f:
            state = json.load(f)
    except Exception as e:
        return {"status": "error", "message": f"Failed to read login state: {str(e)}"}

    # Check expiration (10 minutes)
    if time.time() - state.get('created_at', 0) > 600:
        cleanup_login_files(state_path, captcha_path)
        return {"status": "error", "message": "Login session timed out (10m). Please start again."}

    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)
    session.headers.update({
        'Referer': LOGIN_URL,
        'Origin': BASE_URL,
        'Cookie': f"ASP.NET_SessionId={state['session_id']}"
    })
    session.cookies.update(state.get('cookies', {}))

    post_data = {
        '__VIEWSTATE': state['viewstate'],
        '__VIEWSTATEGENERATOR': state['generator'],
        '__EVENTVALIDATION': state['eventvalidation'],
        'ddl_College': state['college'],
        'UserId_Box': state['username'],
        'PasswordBox': state['password'],
        'BDC_VCID_c_login_examplecaptcha': state['bdc_vcid'],
        'BDC_BackWorkaround_c_login_examplecaptcha': state['bdc_back'],
        'CaptchaCodeTextBox': clean_param(captcha_code),
        'btnLogin': 'Sign In'
    }

    try:
        resp = session.post(LOGIN_URL, data=post_data, timeout=20, allow_redirects=False)

        is_success = False
        new_cookie = session.cookies.get('ASP.NET_SessionId') or state['session_id']

        # Success is typically indicated by 302 redirect to Dashboard.aspx
        location = resp.headers.get('Location', '')
        if resp.status_code in (301, 302, 303) and ('dashboard' in location.lower() or 'default' in location.lower()):
            is_success = True
        elif resp.status_code == 200:
            text = resp.text
            soup = BeautifulSoup(text, 'html.parser')

            # Check explicit errors
            if 'invalid captcha code' in text.lower():
                cleanup_login_files(state_path, captcha_path)
                return {"status": "error", "message": "Invalid CAPTCHA code. Please request a new login."}

            if 'student id does not exist' in text.lower():
                cleanup_login_files(state_path, captcha_path)
                return {"status": "error", "message": "Student ID does not exist. Check college & ID."}

            if 'password' in text.lower() and ('incorrect' in text.lower() or 'invalid' in text.lower()):
                cleanup_login_files(state_path, captcha_path)
                return {"status": "error", "message": "Incorrect password. Please try again."}

            # Check for generic alerts in script
            alert_match = re.search(r'alert\([\'"]([^\'"]+)[\'"]\)', text)
            if alert_match:
                alert_msg = alert_match.group(1)
                cleanup_login_files(state_path, captcha_path)
                return {"status": "error", "message": alert_msg}

        # Verify authentication by fetching Dashboard.aspx
        if not is_success:
            dash_resp = session.get(BASE_URL + 'Dashboard.aspx', timeout=10)
            if dash_resp.status_code == 200 and 'login' not in dash_resp.url.lower():
                dash_soup = BeautifulSoup(dash_resp.text, 'html.parser')
                if dash_soup.find(class_='user-panel') or 'dashboard' in dash_resp.text.lower():
                    is_success = True

        if is_success:
            # Extract student name from dashboard
            student_name = ""
            try:
                dash_resp = session.get(BASE_URL + 'Dashboard.aspx', timeout=10)
                if dash_resp.status_code == 200:
                    dash_soup = BeautifulSoup(dash_resp.text, 'html.parser')
                    student_name = get_student_info(dash_soup)
            except Exception:
                pass

            # Save to per-user session file
            user_sessions_dir = os.path.join(AUTH_DIR, 'sessions')
            os.makedirs(user_sessions_dir, exist_ok=True)
            user_session_file = os.path.join(user_sessions_dir, f"{safe_prefix}.txt")
            with open(user_session_file, 'w') as f:
                f.write(new_cookie)

            # Mirror to global session.txt only for default or owner
            if safe_prefix in ('default', 'cli', '242528230109359_lid', '919455515206_s_whatsapp_net'):
                with open(SESSION_FILE, 'w') as f:
                    f.write(new_cookie)

            cleanup_login_files(state_path, captcha_path)
            return {
                "status": "ok",
                "session_id": new_cookie,
                "student_name": student_name,
                "message": "Login successful. Session cookie saved."
            }
        else:
            cleanup_login_files(state_path, captcha_path)
            return {"status": "error", "message": "Login failed. Please verify student ID, password, and college."}

    except Exception as e:
        cleanup_login_files(state_path, captcha_path)
        return {"status": "error", "message": f"Exception during login submit: {str(e)}"}


def cleanup_login_files(state_path, captcha_path):
    """Remove temporary login state and captcha files."""
    try:
        if os.path.exists(state_path):
            os.remove(state_path)
        if os.path.exists(captcha_path):
            os.remove(captcha_path)
    except Exception:
        pass


def interactive_terminal_login():
    """Interactive login workflow for terminal use."""
    print("=== iCampus Interactive Login ===")
    print("Available colleges: UCRN (Engineering), UCEN (Education), UIMN (Management)")
    college = input("Enter College code [default: UCRN]: ").strip().upper()
    if not college:
        college = "UCRN"

    username = input("Enter Student ID: ").strip()
    if not username:
        print("Error: Student ID cannot be empty.")
        return

    password = getpass.getpass("Enter Password: ").strip()
    if not password:
        print("Error: Password cannot be empty.")
        return

    print("\nFetching CAPTCHA from iCampus...")
    res = login_init(college, username, password, session_prefix="cli")
    if res["status"] != "ok":
        print(f"❌ {res['message']}")
        return

    captcha_path = res["captcha_path"]
    print(f"CAPTCHA image saved to: {captcha_path}")

    if sys.platform == "darwin":
        os.system(f"open '{captcha_path}'")

    captcha_code = input("Enter the CAPTCHA code shown in the image: ").strip()
    if not captcha_code:
        print("Error: CAPTCHA code cannot be empty.")
        return

    print("Authenticating...")
    sub_res = login_submit(captcha_code, session_prefix="cli")
    if sub_res["status"] == "ok":
        print(f"✅ {sub_res['message']}")
        print(f"Session cookie saved to {SESSION_FILE}: {sub_res['session_id']}")
    else:
        print(f"❌ {sub_res['message']}")


def get_student_info(soup):
    """Extract student name and roll number from page."""
    user_panel = soup.find(class_='user-panel')
    if user_panel:
        return user_panel.get_text(separator=' ', strip=True)
    return ""


def format_fee_response(soup):
    """Parse and format fee details from FeeInfo_New.aspx."""
    student = get_student_info(soup)
    table = soup.find('table', id=lambda x: x and 'ExistingGridView' in x)
    if not table:
        return None

    rows = table.find_all('tr')
    if len(rows) < 2:
        return None

    output = ["💰 *iCampus Fee Information*"]
    if student:
        output.append(f"👤 *{student}*\n")

    total_row = None
    item_rows = []

    for tr in rows[1:]:
        cells = [c.get_text(strip=True) for c in tr.find_all(['td', 'th'])]
        if not cells or len(cells) < 4:
            continue

        # Check for TOTAL row
        if any('TOTAL' in str(c).upper() for c in cells):
            total_row = cells
            continue

        # Normal row: S.No, Particulars, Installment, Amount Due, Amount Paid, Balance
        if len(cells) >= 6:
            sno, particular, inst, due, paid, bal = cells[:6]
            item_rows.append(
                f"• *{particular}* (Inst. {inst})\n"
                f"  Due: ₹{due} | Paid: ₹{paid} | *Balance: ₹{bal}*"
            )
        elif len(cells) >= 4:
            item_rows.append("• " + " | ".join(cells))

    if item_rows:
        output.extend(item_rows)

    if total_row:
        output.append("\n━━━━━━━━━━━━━━━━━━━")
        # Extract the last 3 numbers for Total Due, Paid, Balance
        nums = [c for c in total_row if re.match(r'^\d+(\.\d+)?$', c)]
        if len(nums) >= 3:
            output.append(f"📊 *TOTAL DUE*: ₹{nums[0]}")
            output.append(f"💵 *TOTAL PAID*: ₹{nums[1]}")
            output.append(f"⚠️ *TOTAL BALANCE*: ₹{nums[2]}")
        else:
            output.append(f"📊 *SUMMARY*: {' | '.join(c for c in total_row if c)}")

    return "\n".join(output)


def format_num_clean(val):
    """Format numeric string: remove decimals if whole number (e.g. 18.0 -> 18)."""
    try:
        f = float(str(val).replace(',', '').strip())
        return str(int(f)) if f.is_integer() else f"{f:.1f}"
    except (ValueError, TypeError):
        return str(val).strip()


def format_attendance_response(soup):
    """Parse and format attendance details from StudentAttendance.aspx with overall average."""
    student = get_student_info(soup)
    table = soup.find('table', id=lambda x: x and 'ExistingGridView' in x)
    if not table:
        return None

    rows = table.find_all('tr')
    if len(rows) < 2:
        return None

    subject_rows = []
    tot_lectures = 0.0
    tot_present = 0.0
    tot_absent = 0.0

    for tr in rows[1:]:
        cells = [c.get_text(strip=True) for c in tr.find_all(['td', 'th'])]
        # Expected: SNo, Subject Name, Code, Start, Updated, Total, Present, Absent, Attendance %
        if len(cells) >= 9:
            sno, name, code, _, _, total, present, absent, pct = cells[:9]

            # Skip header repeats or footer total rows if any
            if 'total' in sno.lower() or 'total' in name.lower() or not sno.strip().isdigit():
                continue

            try:
                t_val = float(total.replace(',', ''))
                p_val = float(present.replace(',', ''))
                a_val = float(absent.replace(',', ''))
                tot_lectures += t_val
                tot_present += p_val
                tot_absent += a_val
            except (ValueError, TypeError):
                pass

            pres_disp = format_num_clean(present)
            tot_disp = format_num_clean(total)
            abs_disp = format_num_clean(absent)

            subject_rows.append(
                f"*{sno}. {name}* ({code})\n"
                f"   Present: {pres_disp}/{tot_disp} | Absent: {abs_disp}\n"
                f"   *Attendance: {pct}*\n"
            )
        elif len(cells) >= 4:
            subject_rows.append("• " + " | ".join(cells))

    if not subject_rows:
        return None

    output = ["📋 *iCampus Attendance Summary*"]
    if student:
        output.append(f"👤 *{student}*")

    if tot_lectures > 0:
        avg_pct = (tot_present / tot_lectures) * 100
        pres_all = format_num_clean(tot_present)
        tot_all = format_num_clean(tot_lectures)
        output.append(f"🎯 *Overall Average: {avg_pct:.2f}%* ({pres_all}/{tot_all} attended)\n")
    else:
        output.append("")

    output.extend(subject_rows)

    if tot_lectures > 0:
        avg_pct = (tot_present / tot_lectures) * 100
        pres_all = format_num_clean(tot_present)
        tot_all = format_num_clean(tot_lectures)
        abs_all = format_num_clean(tot_absent)

        output.append("━━━━━━━━━━━━━━━━━━━")
        output.append(
            f"📊 *OVERALL ATTENDANCE SUMMARY*\n"
            f"   • Total Lectures: {tot_all}\n"
            f"   • Total Present: {pres_all}\n"
            f"   • Total Absent: {abs_all}\n"
            f"   🎯 *Average Attendance: {avg_pct:.2f}%*"
        )

    return "\n".join(output)


def format_timetable_response(soup):
    """Parse timetable from TimeTable.aspx."""
    student = get_student_info(soup)
    output = ["📅 *iCampus Class Schedule / Timetable*"]
    if student:
        output.append(f"👤 *{student}*\n")

    tables = soup.find_all('table')
    table_found = False
    for table in tables:
        rows = table.find_all('tr')
        for tr in rows:
            cells = [c.get_text(strip=True) for c in tr.find_all(['th', 'td'])]
            if cells and any(cells):
                output.append(" | ".join(c for c in cells if c))
                table_found = True

    if not table_found:
        box = soup.find(class_='box') or soup.find(class_='content') or soup.find(id='ContentPlaceHolder1_UpdatePanel1')
        if box:
            lines = [l.strip() for l in box.get_text(separator='\n', strip=True).splitlines() if l.strip()]
            output.extend(lines)
            output.append("\nℹ️ _Note: No daily schedule matrix has been uploaded for your batch yet._")
        else:
            output.append("No timetable entries found.")

    return "\n".join(output)


def format_marks_response(soup):
    """Parse sessional marks from SessionalMarks.aspx."""
    student = get_student_info(soup)
    output = ["📝 *iCampus Sessional Marks*"]
    if student:
        output.append(f"👤 *{student}*\n")

    table = soup.find('table', id=lambda x: x and 'GridView' in x)
    if table:
        rows = table.find_all('tr')
        for tr in rows:
            cells = [c.get_text(strip=True) for c in tr.find_all(['th', 'td'])]
            if cells:
                output.append(" | ".join(cells))
    else:
        output.append("No sessional marks currently published or exam not selected.")

    return "\n".join(output)


def fetch_with_cookie(cookie, intent):
    """Fetch data from iCampus using the saved session cookie."""
    clean_cookie = clean_param(cookie)
    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)
    session.headers.update({
        'Cookie': f'ASP.NET_SessionId={clean_cookie}'
    })

    intent_key = intent.lower().strip()
    if intent_key in ('attendance', 'attandence', 'attendance average', 'attandence average', 'attendance avg', 'avg attendance', 'average attendance', 'hajiri'):
        intent_key = 'attendance'
    elif intent_key in ('fee', 'fees'):
        intent_key = 'fee'
    elif intent_key in ('timetable', 'time table', 'schedule'):
        intent_key = 'timetable'
    elif intent_key in ('marks', 'sessional'):
        intent_key = 'marks'

    # Exact portal URLs discovered from iCampus dashboard
    url_map = {
        'fee': [
            BASE_URL + 'FeeInfo_New.aspx',
            BASE_URL + 'Dashboard.aspx'
        ],
        'attendance': [
            BASE_URL + 'StudentAttendance.aspx',
            BASE_URL + 'StudAttendance_DayWise.aspx',
            BASE_URL + 'AttendanceHistory.aspx'
        ],
        'timetable': [
            BASE_URL + 'TimeTable.aspx'
        ],
        'time table': [
            BASE_URL + 'TimeTable.aspx'
        ],
        'marks': [
            BASE_URL + 'SessionalMarks.aspx'
        ],
        'profile': [
            BASE_URL + 'StudentProfile.aspx',
            BASE_URL + 'Dashboard.aspx'
        ]
    }

    urls = url_map.get(intent_key, [BASE_URL + 'Dashboard.aspx'])

    for url in urls:
        try:
            resp = session.get(url, timeout=15, allow_redirects=True)

            # Check if session is expired or redirected to login
            if resp.status_code != 200 or 'login' in resp.url.lower() or 'genericerrorpage' in resp.url.lower():
                continue

            soup = BeautifulSoup(resp.text, 'html.parser')

            # Check if page is login page
            title_text = soup.title.text.lower() if soup.title else ''
            if 'log in' in title_text or 'login' in title_text:
                continue

            # Format specific intent
            if intent_key in ('fee', 'fees'):
                formatted = format_fee_response(soup)
                if formatted:
                    return formatted

            elif intent_key in ('attendance', 'hajiri'):
                formatted = format_attendance_response(soup)
                if formatted:
                    return formatted

            elif intent_key in ('timetable', 'time table', 'schedule'):
                formatted = format_timetable_response(soup)
                if formatted:
                    return formatted

            elif intent_key in ('marks', 'sessional'):
                formatted = format_marks_response(soup)
                if formatted:
                    return formatted

            # Generic fallback text extraction
            for tag in soup(['script', 'style', 'nav', 'header', 'footer']):
                tag.decompose()

            text = soup.get_text(separator='\n', strip=True)
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            if lines:
                student = get_student_info(soup)
                res = [f"📊 *iCampus Data for {intent_key.title()}*"]
                if student:
                    res.append(f"👤 *{student}*\n")
                res.extend(lines[:25])
                return "\n".join(res)

        except Exception:
            continue

    return f"❌ No data found for *{intent}*. Session may be expired.\nPlease type: `login <student_id> <password>` to login again."


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python3 icampus_fetcher.py login")
        print("  python3 icampus_fetcher.py login-init <college> <username> <password> [prefix]")
        print("  python3 icampus_fetcher.py login-submit <captcha_code> [prefix]")
        print("  python3 icampus_fetcher.py <cookie> <intent>")
        sys.exit(1)

    cmd = sys.argv[1].lower()

    if cmd == "login":
        interactive_terminal_login()

    elif cmd == "login-init":
        if len(sys.argv) < 5:
            print(json.dumps({"status": "error", "message": "Usage: login-init <college> <username> <password> [prefix]"}))
            sys.exit(1)
        college = sys.argv[2]
        username = sys.argv[3]
        password = sys.argv[4]
        prefix = sys.argv[5] if len(sys.argv) > 5 else "default"
        res = login_init(college, username, password, session_prefix=prefix)
        print(json.dumps(res))

    elif cmd == "login-submit":
        if len(sys.argv) < 3:
            print(json.dumps({"status": "error", "message": "Usage: login-submit <captcha_code> [prefix]"}))
            sys.exit(1)
        captcha_code = sys.argv[2]
        prefix = sys.argv[3] if len(sys.argv) > 3 else "default"
        res = login_submit(captcha_code, session_prefix=prefix)
        print(json.dumps(res))

    else:
        # Fallback to existing <cookie> <intent> usage
        if len(sys.argv) >= 3:
            cookie = sys.argv[1]
            intent = sys.argv[2]
            result = fetch_with_cookie(cookie, intent)
            print(result)
        else:
            print("Unknown command. Run without arguments for help.")
            sys.exit(1)


if __name__ == "__main__":
    main()