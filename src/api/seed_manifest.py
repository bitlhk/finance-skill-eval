"""Read-only account seed manifest using the same policy as API admission."""
import argparse
import json
from api.identity import seed_files, digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory')
    options = parser.parse_args()
    files = [{'path': name, 'sha256': digest(content)} for name, content in seed_files(options.directory)]
    print(json.dumps({'schemaVersion': 'finance.account-seed.v1',
        'sha256': digest(json.dumps(files, ensure_ascii=False, separators=(',', ':'))), 'files': files}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
