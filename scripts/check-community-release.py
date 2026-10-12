#!/usr/bin/env python3
"""Open agentNote's community release check in the signed-in 360 browser."""

import argparse
import subprocess
import sys
import time

BROWSER_ID = "net.qihoo.360browser"
DASHBOARD = "https://community.obsidian.md/account/plugins/agentnote"
CHECK_RELEASE = DASHBOARD + "/check-release"


def open_in_360(url):
    subprocess.run(["/usr/bin/open", "-b", BROWSER_ID, url], check=True, timeout=15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dashboard-only", action="store_true", help="Open the dashboard without requesting a release scan.")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This script requires macOS and 360极速浏览器Pro.")
    try:
        open_in_360(DASHBOARD)
        if not args.dashboard_only:
            time.sleep(2)
            # The observed 'Check for new releases' link navigates to this URL.
            open_in_360(CHECK_RELEASE)
            print("EE，我已经用 360 打开版本检查页。请以页面的扫描排队提示为准；如果显示登录页，登录后再次运行。")
        else:
            print("EE，我已经用 360 打开 agentNote 社区管理页。")
    except (subprocess.SubprocessError, OSError) as error:
        print(f"EE，我已经尝试打开 360，但未能完成：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
