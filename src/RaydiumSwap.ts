import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, TransactionMessage } from '@solana/web3.js'
import {
  Liquidity,
  LiquidityPoolKeys,
  jsonInfo2PoolKeys,
  LiquidityPoolJsonInfo,
  TokenAccount,
  Token,
  TokenAmount,
  TOKEN_PROGRAM_ID,
  Percent,
  SPL_ACCOUNT_LAYOUT,
} from '@raydium-io/raydium-sdk'
import { Wallet } from '@coral-xyz/anchor'
import bs58 from 'bs58'
import { readFile } from 'fs/promises'

class RaydiumSwap {
  allPoolKeysJson: LiquidityPoolJsonInfo[]
  connection: Connection
  wallet: Wallet

  constructor(RPC_URL: string, WALLET_PRIVATE_KEY: string) {
    this.connection = new Connection(RPC_URL
      , { commitment: 'confirmed' })
    this.wallet = new Wallet(Keypair.fromSecretKey(Uint8Array.from(bs58.decode(WALLET_PRIVATE_KEY))))
  }

  async loadPoolKeys(liquidityFile: string) {
    const liquidityJsonResp = await fetch(liquidityFile);
    if (!liquidityJsonResp.ok) return
    const liquidityJson = (await liquidityJsonResp.json()) as { official: any; unOfficial: any }
    const allPoolKeysJson = [...(liquidityJson?.official ?? []), ...(liquidityJson?.unOfficial ?? [])]

    this.allPoolKeysJson = allPoolKeysJson
  }

  async findPoolInfoForTokens(mintA: string, mintB: string): Promise<LiquidityPoolKeys | null> {
    // const poolData = this.allPoolKeysJson.find(
    //   (i) => (i.baseMint === mintA && i.quoteMint === mintB) || (i.baseMint === mintB && i.quoteMint === mintA)
    // )

    // if (!poolData) return null

    // return jsonInfo2PoolKeys(poolData) as LiquidityPoolKeys

    try {
      const fileContent = await readFile('mainnet.json', 'utf8');
      const allPoolKeys = JSON.parse(fileContent);

      const poolData = allPoolKeys.find(
        (i: any) => (i.baseMint === mintA && i.quoteMint === mintB) || (i.baseMint === mintB && i.quoteMint === mintA)
      );

      if (!poolData) return null;

      return jsonInfo2PoolKeys(poolData) as LiquidityPoolKeys;
    } catch (error) {
      console.error('Error reading or parsing mainnet.json:', error);
      return null;
    }
  }

  async getOwnerTokenAccounts() {
    const walletTokenAccount = await this.connection.getTokenAccountsByOwner(this.wallet.publicKey, {
      programId: TOKEN_PROGRAM_ID,
    })

    return walletTokenAccount.value.map((i) => ({
      pubkey: i.pubkey,
      programId: i.account.owner,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
    }))
  }

  async getSwapTransaction(
    toToken: string,
    // fromToken: string,
    amount: number,
    poolKeys: LiquidityPoolKeys,
    maxLamports: number = 100000,
    useVersionedTransaction = true,
    fixedSide: 'in' | 'out' = 'in',
    slippagePercent: number
  ): Promise<Transaction | VersionedTransaction> {
    const directionIn = poolKeys.quoteMint.toString() == toToken
    const { minAmountOut, amountIn } = await this.calcAmountOut(poolKeys, amount, directionIn, slippagePercent)
    console.log({ minAmountOut, amountIn });
    const userTokenAccounts = await this.getOwnerTokenAccounts()
    const swapTransaction = await Liquidity.makeSwapInstructionSimple({
      connection: this.connection,
      makeTxVersion: useVersionedTransaction ? 0 : 1,
      poolKeys: {
        ...poolKeys,
      },
      userKeys: {
        tokenAccounts: userTokenAccounts,
        owner: this.wallet.publicKey,
      },
      amountIn: amountIn,
      amountOut: minAmountOut,
      fixedSide: fixedSide,
      config: {
        bypassAssociatedCheck: false,
      },
      computeBudgetConfig: {
        microLamports: maxLamports,
      },
    })

    const recentBlockhashForSwap = await this.connection.getLatestBlockhash()
    const instructions = swapTransaction.innerTransactions[0].instructions.filter(Boolean)

    if (useVersionedTransaction) {
      const versionedTransaction = new VersionedTransaction(
        new TransactionMessage({
          payerKey: this.wallet.publicKey,
          recentBlockhash: recentBlockhashForSwap.blockhash,
          instructions: instructions,
        }).compileToV0Message()
      )

      versionedTransaction.sign([this.wallet.payer])

      return versionedTransaction
    }

    const legacyTransaction = new Transaction({
      blockhash: recentBlockhashForSwap.blockhash,
      lastValidBlockHeight: recentBlockhashForSwap.lastValidBlockHeight,
      feePayer: this.wallet.publicKey,
    })

    legacyTransaction.add(...instructions)

    return legacyTransaction
  }

  async sendLegacyTransaction(tx: Transaction, maxRetries?: number) {
    const txid = await this.connection.sendTransaction(tx, [this.wallet.payer], {
      skipPreflight: true,
      maxRetries: maxRetries,
    })

    return txid
  }

  async sendVersionedTransaction(tx: VersionedTransaction, maxRetries?: number) {
    const txid = await this.connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: maxRetries,
    })

    return txid
  }

  async simulateLegacyTransaction(tx: Transaction) {
    const txid = await this.connection.simulateTransaction(tx, [this.wallet.payer])

    return txid
  }

  async simulateVersionedTransaction(tx: VersionedTransaction) {
    const txid = await this.connection.simulateTransaction(tx)

    return txid
  }

  getTokenAccountByOwnerAndMint(mint: PublicKey) {
    return {
      programId: TOKEN_PROGRAM_ID,
      pubkey: PublicKey.default,
      accountInfo: {
        mint: mint,
        amount: 0,
      },
    } as unknown as TokenAccount
  }

  async calcAmountOut(poolKeys: LiquidityPoolKeys, rawAmountIn: number, swapInDirection: boolean, slippagePercent: number) {
    const poolInfo = await Liquidity.fetchInfo({ connection: this.connection, poolKeys })

    let currencyInMint = poolKeys.baseMint
    let currencyInDecimals = poolInfo.baseDecimals
    let currencyOutMint = poolKeys.quoteMint
    let currencyOutDecimals = poolInfo.quoteDecimals

    if (!swapInDirection) {
      currencyInMint = poolKeys.quoteMint
      currencyInDecimals = poolInfo.quoteDecimals
      currencyOutMint = poolKeys.baseMint
      currencyOutDecimals = poolInfo.baseDecimals
    }

    const currencyIn = new Token(TOKEN_PROGRAM_ID, currencyInMint, currencyInDecimals)
    const amountIn = new TokenAmount(currencyIn, rawAmountIn, false)
    const currencyOut = new Token(TOKEN_PROGRAM_ID, currencyOutMint, currencyOutDecimals)
    const slippage = new Percent(slippagePercent, 100)

    const { amountOut, minAmountOut, currentPrice, executionPrice, priceImpact, fee } = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut,
      slippage,
    })

    return {
      amountIn,
      amountOut,
      minAmountOut,
      currentPrice,
      executionPrice,
      priceImpact,
      fee,
    }
  }
}

export default RaydiumSwap
