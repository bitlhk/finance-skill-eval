"""Stable CLI entry; implementation belongs to runtime.builder_command."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime.builder_command import main

if __name__ == "__main__":
    main()
