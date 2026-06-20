/// Collateral top-up — same signature the rescue PTB calls:
///   deposit_collateral::deposit_collateral<T>(version, obligation, market, coin)
/// (trailing &mut TxContext auto-injected; the PTB passes 4 args, no clock).
module scallop_demo::deposit_collateral {
    use sui::coin::{Self, Coin};
    use scallop_demo::market::{Version, Market, Obligation, apply_collateral};

    public entry fun deposit_collateral<T>(
        _version: &Version,
        obligation: &mut Obligation,
        market: &mut Market,
        coin: Coin<T>,
        ctx: &mut TxContext,
    ) {
        let amt = coin::value(&coin);
        apply_collateral(market, obligation, amt);
        transfer::public_transfer(coin, tx_context::sender(ctx));
    }
}
