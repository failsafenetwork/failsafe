// users rarely promise funds to the hub, so there is no periodic rebalance
// 1. users can do manual rebalance, e.g. tranfering funds from old to better hub
// 2. used for direct settlement and large transfers
const withdraw = require('../offchain/withdraw')

module.exports = async (p) => {
  let asset = parseInt(p.asset)

  // three types of actions
  let withdrawFrom = []
  let depositTo = []
  let disputes = []

  // withdrawing promises
  let await_all = []

  let balance = me.record.asset(asset)

  // do something with every channel
  for (let action of p.chActions) {
    let ch = await me.getChannel(fromHex(action.partnerId), action.asset)

    if (action.startDispute) {
      disputes.push(await ch.d.getDispute())
    }

    if (action.depositAmount > 0) {
      if (action.withdrawAmount > 0) {
        react({
          alert: "It's pointless to deposit and withdraw at the same time"
        })
        return
      }

      balance -= action.depositAmount

      depositTo.push([action.depositAmount, me.record.id, ch.partner, 0])
    }

    if (action.withdrawAmount == 0) {
      continue
    }

    if (action.withdrawAmount > ch.insured) {
      react({alert: 'More than you can withdraw from insured'})
      return
    }

    // waiting for the response
    await_all.push(withdraw(ch, action.withdrawAmount))
  }

  // await withdrawal proofs from all parties, or get timed out
  await_all = await Promise.all(await_all)

  // did any fail? If so, cancel entire operation
  let failed_ch = await_all.find((ch) => ch.d.withdrawal_sig == null)
  if (failed_ch) {
    react({
      alert:
        'Failed to get withdrawal from: ' +
        failed_ch.hub.handle +
        '. Try later or start a dispute.'
    })
    return
  }

  // otherwise, proceed and add them
  for (let ch of await_all) {
    balance += ch.d.withdrawal_amount

    // if there is anything to withdraw the user is already registred
    withdrawFrom.push([ch.d.withdrawal_amount, ch.partner, ch.d.withdrawal_sig])
  }

  // external deposits are everything else other than you@anyhub
  for (let dep of p.externalDeposits) {
    // split by @
    if (dep.to.length > 0) {
      let to = dep.to
      let userId

      // looks like a pubkey
      if (to.length == 64) {
        userId = Buffer.from(to, 'hex')

        // maybe this pubkey is already registred?
        let u = await User.idOrKey(userId)

        if (u.id) {
          userId = u.id
        }
      } else {
        // looks like numerical ID
        userId = parseInt(to)

        let u = await User.idOrKey(userId)

        if (!u) {
          result.alert = 'User with short ID ' + userId + " doesn't exist."
          break
        }
      }

      let amount = parseInt(dep.depositAmount)

      let withPartner = 0
      // @onchain or @0 mean onchain balance
      if (dep.hub && dep.hub != 'onchain') {
        // find a hub by its handle or id
        let h = K.hubs.find((h) => h.handle == dep.hub || h.id == dep.hub)
        if (h) {
          withPartner = h.id
        } else {
          react({alert: 'No such hub'})
          return
        }
      }

      if (amount > 0) {
        balance -= amount

        depositTo.push([
          amount,
          userId,
          withPartner,
          dep.invoice ? Buffer.from(dep.invoice, 'hex') : 0
        ])
      }
    }
  }

  if (balance < 0) {
    react({alert: 'Your final balance will become negative: not enough funds.'})
    return
  }

  if (disputes.length + withdrawFrom.length + depositTo.length == 0) {
    react({alert: 'Nothing to send onchain'})
    return
  } else {
    // finally flushing all of them to pending batch
    if (withdrawFrom.length > 0)
      me.batch.push(['withdrawFrom', asset, withdrawFrom])
    if (depositTo.length > 0) me.batch.push(['depositTo', asset, depositTo])
    if (disputes.length > 0) me.batch.push(['disputeWith', asset, disputes])

    react({confirm: 'Onchain tx added.'})
  }
}
