/// Seal probe: an identity is `bcs(u64 unlock_ms) || nonce`; decryption is granted once the Clock reaches unlock_ms.
module seal_probe::time_gate;

use sui::bcs;
use sui::clock::Clock;

const ENoAccess: u64 = 0;

entry fun seal_approve(id: vector<u8>, clock: &Clock) {
    let mut reader = bcs::new(id);
    let unlock_ms = reader.peel_u64();
    assert!(clock.timestamp_ms() >= unlock_ms, ENoAccess);
}
