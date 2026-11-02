"""Single process entry for the platform's engineering roles."""
import asyncio
import json
import logging
import sys
from environment_check import check_environment


def main():
    check_environment()
    protocol = sys.stdout
    sys.stdout = sys.stderr
    logging.disable(logging.INFO)
    from operational_logging import configure_sdk_logging
    configure_sdk_logging()
    from bundle_agent import run_bundle
    request = json.loads(sys.stdin.read())
    if not isinstance(request.get('bundle'), dict):
        raise ValueError('Platform agent requires the unified task contract')
    asyncio.run(run_bundle(request, protocol))


if __name__ == '__main__':
    main()
