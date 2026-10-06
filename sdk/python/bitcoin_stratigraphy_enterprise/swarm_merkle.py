# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""RFC 6962-style ordered, unpadded Merkle hashing and audit paths (stdlib only)."""
import hashlib
import hmac

MAX_LEAVES = 1_000_000


class MerkleProofError(ValueError):
    """Malformed tree input or audit path."""


def leaf_hash(data):
    if type(data) is not bytes:
        raise MerkleProofError("Leaf preimages must be bytes")
    return hashlib.sha256(b"\x00" + data).digest()


def node_hash(left, right):
    if type(left) is not bytes or type(right) is not bytes or len(left) != 32 or len(right) != 32:
        raise MerkleProofError("Child hashes must be 32 bytes")
    return hashlib.sha256(b"\x01" + left + right).digest()


def split_size(size):
    """Largest power of two strictly smaller than a nonsingleton tree."""
    if type(size) is not int or not 2 <= size <= MAX_LEAVES:
        raise MerkleProofError("Expected a bounded nonsingleton tree")
    return 1 << ((size - 1).bit_length() - 1)


def validate_position(index, size):
    if type(size) is not int or not 1 <= size <= MAX_LEAVES:
        raise MerkleProofError("Invalid tree size")
    if type(index) is not int or not 0 <= index < size:
        raise MerkleProofError("Leaf index outside this tree")


class MerkleAccumulator:
    """Append hashes in O(log n) worst case; retain perfect subtrees for proofs.

    No duplicate-last-leaf padding. Root retrieval folds at most O(log n)
    perfect subtrees. Leaves are ordered by acceptance, not claimed wall time.
    """
    def __init__(self, max_leaves=10_000):
        if type(max_leaves) is not int or not 1 <= max_leaves <= MAX_LEAVES:
            raise MerkleProofError("Invalid leaf capacity")
        self.max_leaves = max_leaves
        self.size = 0
        self._nodes = {}

    def append(self, data):
        digest = leaf_hash(data)
        if self.size >= self.max_leaves:
            raise MerkleProofError("Tree capacity reached; flush before appending")
        index = start = self.size
        width = 1
        self._nodes[start, width] = digest
        while start % (2 * width):
            digest = node_hash(self._nodes[start - width, width], digest)
            start -= width
            width *= 2
            self._nodes[start, width] = digest
        self.size += 1
        return index

    def _subtree(self, start, size):
        cached = self._nodes.get((start, size))
        if cached is not None:
            return cached
        width = split_size(size)
        return node_hash(self._subtree(start, width), self._subtree(start + width, size - width))

    @property
    def root(self):
        return self._subtree(0, self.size) if self.size else hashlib.sha256(b"").digest()

    def inclusion_path(self, index):
        validate_position(index, self.size)

        def walk(start, size, offset):
            if size == 1:
                return []
            width = split_size(size)
            if offset < width:
                return walk(start, width, offset) + [self._subtree(start + width, size - width)]
            return walk(start + width, size - width, offset - width) + [self._subtree(start, width)]

        return walk(0, self.size, index)


def verify_merkle_inclusion(data, index, size, siblings, root):
    """Return False for a digest mismatch; reject malformed/extra/short paths."""
    validate_position(index, size)
    if type(root) is not bytes or len(root) != 32:
        raise MerkleProofError("Root must be 32 bytes")
    if type(siblings) is not list or len(siblings) > 20:
        raise MerkleProofError("Invalid bounded sibling path")
    for sibling in siblings:
        if type(sibling) is not bytes or len(sibling) != 32:
            raise MerkleProofError("Sibling hash must be 32 bytes")
    path = tuple(siblings)
    used = 0
    digest = leaf_hash(data)

    def rebuild(offset, width):
        nonlocal used
        if width == 1:
            return digest
        split = split_size(width)
        left = offset < split
        child = rebuild(offset if left else offset - split, split if left else width - split)
        if used >= len(path):
            raise MerkleProofError("Audit path is too short")
        sibling = path[used]
        used += 1
        return node_hash(child, sibling) if left else node_hash(sibling, child)

    computed = rebuild(index, size)
    if used != len(path):
        raise MerkleProofError("Audit path contains extra hashes")
    return hmac.compare_digest(computed, root)
