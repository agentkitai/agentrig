// Trusted-host source entry. R19b already registers and validates the reserved
// packs.ship compatibility namespace; do not override its schema here.
export const shipPack = {
  name: "ship",
  summary: "Shipping workflow helpers",
  commands: [{
    name: "info",
    summary: "Describe the source ship pack",
    run(_argv, { print }) { print("ship: packs.ship config; scripts and dispatch-record extension (source pack)"); },
  }],
};
