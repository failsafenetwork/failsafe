// receive a transition for state channel
module.exports = async (msg) => {
  var [pubkey, sig, body] = r(msg)

  if (!ec.verify(body, sig, pubkey)) {
    return l('Wrong input')
  }

  // ackSig defines the sig of last known state between two parties.
  // then each transitions contains an action and an ackSig after action is committed
  // debugState/signedState are purely for debug phase
  var [method, ackSig, transitions, debugState, signedState] = r(body)

  if (methodMap(readInt(method)) != 'update') {
    l('Invalid update input')
    return false
  }

  prettyState(debugState)
  prettyState(signedState)

  var ch = await me.getChannel(pubkey)

  // first, clone what they can pay and decrement
  var receivable = ch.they_payable

  // an array of partners we need to ack or flush changes at the end of processing
  var flushable = []

  // this is state we are on right now.
  var newState = await ch.d.getState()

  var rollback = [0, 0]

  l(
    `ours ${newState[1][2]} but ${debugState[1][2]}. We are in: ${
      ch.d.status
    } Tx ${transitions.length}`
  )
  //l(stringify(newState))
  //l(stringify(debugState))

  if (!await ch.d.saveState(newState, ackSig)) {
    if (transitions.length == 0) return l('Empty invalid ack')

    l('Ack mismatch. States (current, signed, theirs):')

    oldState = r(ch.d.signed_state)
    prettyState(oldState)

    logstate(newState)
    logstate(oldState)
    logstate(debugState)
    logstate(signedState)

    //if (ch.d.status == 'rollback') return l('Rollback cant rollback')

    /*
    We received an acksig that doesnt match our current state. Apparently the partner sent
    transitions simultaneously. 

    Our job is to rollback to last known signed state, check ackSig against it, if true - apply
    partner's transitions, and then reapply the difference we made with OUR transitions
    namely - nonce and offdelta diffs because hashlocks are already processed. 
    
    We hope the partner does the same with our transitions so we both end up on equal states.

    */

    if (!await ch.d.saveState(oldState, ackSig)) {
      return l('Dead lock!')
    } else {
      l('Rollback to old state')

      rollback = [
        newState[1][2] - oldState[1][2],
        newState[1][3] - oldState[1][3]
      ]
      newState = oldState
    }
  }

  var outwards = newState[ch.left ? 3 : 2]

  // we apply a transition to canonical state, if sig is valid - execute the action
  for (var t of transitions) {
    var m = methodMap(readInt(t[0]))
    if (m == 'addlock' || m == 'add') {
      var [amount, hash, exp, destination, unlocker] = t[1]

      exp = readInt(exp)
      amount = readInt(amount)

      if (amount < 0 || amount > receivable) {
        return l('Invalid transfer ', amount)
      }
      receivable -= amount

      newState[1][2]++ //nonce
      if (m == 'addlock') {
        // push a hashlock
        newState[ch.left ? 2 : 3].push([amount, hash, exp])
      } else {
        // modify offdelta directly
        //newState[4] += offdelta
      }

      // check new state and sig, save
      if (!await ch.d.saveState(newState, t[2])) {
        l('Invalid state sig addlock')
        break
      }

      var hl = await ch.d.createPayment({
        status: 'added',
        is_inward: true,

        amount: amount,
        hash: hash,
        exp: exp,

        unlocker: unlocker
      })

      // pay to unlocker
      if (destination.equals(me.pubkey)) {
        unlocker = r(unlocker)
        var unlocked = nacl.box.open(
          unlocker[0],
          unlocker[1],
          unlocker[2],
          me.box.secretKey
        )
        if (unlocked == null) {
          l('Bad unlocker')
          hl.status = 'fail'
        } else {
          var [box_amount, box_secret, box_invoice] = r(bin(unlocked))
          box_amount = readInt(box_amount)

          var paid_invoice = invoices[toHex(box_invoice)]

          // TODO: did we get right amount in right asset?
          if (paid_invoice && amount >= box_amount) {
            //paid_invoice.status == 'pending'
            l('Our invoice was paid!', paid_invoice)
            paid_invoice.status = 'paid'
          } else {
            l('No such invoice found. Donation?')
          }
          react({confirm: 'Received a payment'})

          hl.secret = box_secret
          hl.status = 'settle'
        }

        await hl.save()

        // no need to add to flushable - secret will be returned during ack to sender anyway
      } else if (me.my_hub) {
        l(`Forward ${amount} to peer or other hub ${toHex(destination)}`)
        var outward_amount = afterFees(amount, me.my_hub.fee)

        var dest_ch = await me.getChannel(destination)

        // is online? Is payable?

        if (dest_ch.payable >= outward_amount) {
          await dest_ch.d.save()

          await dest_ch.d.createPayment({
            status: 'add',
            is_inward: false,

            amount: outward_amount,
            hash: hash,
            exp: exp,

            unlocker: unlocker,
            destination: destination
          })

          if (flushable.indexOf(destination) == -1) flushable.push(destination)
        } else {
          hl.status = 'fail'
          await hl.save()
        }
      } else {
        l('We arent receiver and arent a hub O_O')
      }
    } else if (m == 'settlelock' || m == 'settle') {
      var secret = t[1]
      var hash = sha3(secret)

      var index = outwards.findIndex((hl) => hl[1].equals(hash))
      var hl = outwards[index]

      if (!hl) {
        l('No such hashlock')
        break
      }

      // secret was provided, apply to offdelta
      newState[1][2]++ //nonce
      newState[1][3] += ch.left ? -hl[0] : hl[0]
      receivable += hl[0]
      outwards.splice(index, 1)

      // check new state and sig, save
      if (!await ch.d.saveState(newState, t[2])) {
        l('Invalid state sig settle')
        break
      }

      await ch.d.saveState(newState, t[2])

      var outward = (await ch.d.getPayments({
        where: {hash: hash, is_inward: false},
        include: {all: true}
      }))[0]

      outward.secret = secret
      outward.status = 'settled'
      await outward.save()

      var inward = await Payment.findOne({
        where: {hash: hash, is_inward: true},
        include: {all: true}
      })

      if (inward) {
        //l('Found an mediated inward to unlock with ', inward.deltum.partnerId)

        inward.secret = secret
        inward.status = 'settle'
        await inward.save()

        var pull_from = inward.deltum.partnerId

        if (flushable.indexOf(pull_from) == -1) flushable.push(pull_from)
      } else {
        react({confirm: 'Payment completed'})
      }

      if (me.handicap_dontsettle) {
        return l(
          'HANDICAP ON: not settling on a given secret, but pulling from inward'
        )
      }
    } else if (m == 'faillock' || m == 'fail') {
      var hash = t[1]

      var index = outwards.findIndex((hl) => hl[1].equals(hash))
      var hl = outwards[index]

      if (!hl) {
        l('No such hashlock')
        break
      }

      // secret wasn't provided, delete lock
      newState[1][2]++ //nonce
      outwards.splice(index, 1)

      // check new state and sig, save
      if (!await ch.d.saveState(newState, t[2])) {
        l('Invalid state sig fail ')
        break
      }

      await ch.d.saveState(newState, t[2])

      var outward = (await ch.d.getPayments({
        where: {hash: hash, is_inward: false},
        include: {all: true}
      }))[0]

      outward.status = 'failed'
      await outward.save()

      var inward = await outward.getInward()

      if (inward) {
        inward.status = 'fail'
        await inward.save()

        var pull_from = inward.deltum.partnerId

        if (flushable.indexOf(pull_from) == -1) flushable.push(pull_from)
      } else {
        react({alert: 'Payment failed'})
      }
    }
  }

  ch.d.status = 'master'
  ch.d.pending = null

  // since we applied partner's diffs, all we need is to add the diff of our own transitions
  if (rollback[0] > 0) {
    ch.d.nonce += rollback[0]
    ch.d.offdelta += rollback[1]
    ch.d.status = 'rollback'

    var st = await ch.d.getState()
    l('After rollback we are at: ')
    logstate(st)
  }

  await ch.d.save()

  // We only flush when there were any transitions. Not if was just an empty ack
  if (transitions.length > 0) {
    await me.flushChannel(pubkey, true)

    for (var fl of flushable) {
      if (!fl.equals(pubkey)) await me.flushChannel(fl, true)
    }
  }

  /*
  // TESTNET: storing most profitable outcome for us
  var profitable = r(ch.d.most_profitable)
  if (
    (ch.left && ch.d.offdelta > readInt(profitable[0])) ||
    (!ch.left && ch.d.offdelta < readInt(profitable[0]))
  ) {
    ch.d.most_profitable = r([ch.d.offdelta, ch.d.nonce, ch.d.sig])
  }
  */
}