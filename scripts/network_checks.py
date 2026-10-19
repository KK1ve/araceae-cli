"""Inspect Linux connect syscall observations for the loopback-only runtime fixtures."""

import ipaddress
from pathlib import Path
import re


def check_loopback_connections(trace: Path) -> dict:
    addresses = []
    for line in trace.read_text(encoding="utf-8").splitlines():
        if "sa_family=AF_INET" not in line:
            continue
        match = re.search(r'inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)"', line)
        if not match:
            raise ValueError("An Internet connect syscall could not be decoded")
        address = ipaddress.ip_address(match.group(1) or match.group(2))
        peer = getattr(address, "ipv4_mapped", None) or address
        if not peer.is_loopback:
            raise ValueError(f"Runtime fixture attempted a non-loopback connection: {address}")
        addresses.append(str(address))
    if not addresses:
        raise ValueError("Network observation recorded no Internet connect syscalls")
    return {"result": "passed", "connect_attempts": len(addresses), "addresses": sorted(set(addresses)), "trace": str(trace)}
