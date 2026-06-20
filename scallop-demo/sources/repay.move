/// Third-party repay — same signature the rescue PTB calls:
///   repay::repay<T>(version, obligation, market, coin, clock)
/// (the trailing &mut TxContext is auto-injected by the runtime; the PTB passes 5 args).
module scallop_demo::repay {
    use sui::coin::{Self, Coin};
    use sui::clock::Clock;
    use scallop_demo::market::{Version, Market, Obligation, apply_repay};

    public entry fun repay<T>(
        _version: &Version,
        obligation: &mut Obligation,
        market: &mut Market,
        coin: Coin<T>,
        _clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let amt = coin::value(&coin);
        apply_repay(market, obligation, amt);
        // Consume the repaid coin (demo sink): route it to the caller. The rescue still
        // proves the full atomic PTB path; debt is reduced on the obligation.
        transfer::public_transfer(coin, tx_context::sender(ctx));
    }
}
