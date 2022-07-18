/* 
 * This file is part of the warpgate module (https://github.com/trioderegion/warpgate)
 * Copyright (c) 2021 Matthew Haentschke.
 * 
 * This program is free software: you can redistribute it and/or modify  
 * it under the terms of the GNU General Public License as published by  
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but 
 * WITHOUT ANY WARRANTY; without even the implied warranty of 
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU 
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License 
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import {logger} from '../utility/logger.js'
import {MODULE} from '../utility/module.js'
import {Comms} from '../handler/comms.js'
import {RemoteMutator} from './remote-mutator.js'
import {MutationStack} from '../entity/mutation-stack.js'

const NAME = "Mutator";

export class Mutator {
  static register() {
    Mutator.defaults();
    Mutator.hooks();
  }

  static defaults(){
    MODULE[NAME] = {
      comparisonKey: 'name'
    }
  }

  static hooks() {
    Hooks.on('preUpdateToken', Mutator._correctActorLink)
  }

  static _correctActorLink(tokenDoc, update) {

    /* if the actorId has been updated AND its being set to null,
     * check if we can patch/fix this warpgate spawn
     */
    if (update.hasOwnProperty('actorId') && update.actorId === null) {
      const sourceActorId = tokenDoc.getFlag(MODULE.data.name, 'sourceActorId') ?? false;
      if (sourceActorId) {
        logger.debug(`Detected spawned token with unowned actor ${sourceActorId}. Correcting token update.`, tokenDoc, update);
        update.actorId = sourceActorId;
      }
    }
  }

  static _errorCheckEmbeddedUpdates( embeddedName, updates ) {

    /* at the moment, the most pressing error is an Item creation without a 'type' field.
     * This typically indicates a failed lookup for an update operation
     */
    if( embeddedName == 'Item'){
      const badItemAdd = (updates.add ?? []).find( add => !add.type );

      if (badItemAdd) {
        logger.info(badItemAdd);
        const message = MODULE.format('error.badMutate.missing.type', {embeddedName});

        return {error: true, message}
      }
    }

    return {error:false};
  }

  /* run the provided updates for the given embedded collection name from the owner */
  static async _performEmbeddedUpdates(owner, embeddedName, updates, comparisonKey = 'name', options = {}){
    
    const collection = owner.getEmbeddedCollection(embeddedName);

    const parsedAdds = Mutator._parseAddShorthand(collection, updates, comparisonKey);
    const parsedUpdates = Mutator._parseUpdateShorthand(collection, updates, comparisonKey); 
    const parsedDeletes = Mutator._parseDeleteShorthand(collection, updates, comparisonKey);

    logger.debug(`Modify embedded ${embeddedName} of ${owner.name} from`, {adds: parsedAdds, updates: parsedUpdates, deletes: parsedDeletes});

    const {error, message} = Mutator._errorCheckEmbeddedUpdates( embeddedName, {add: parsedAdds, update: parsedUpdates, delete: parsedDeletes} );
    if(error) {
      logger.error(message);
      return false;
    }

    //TODO compress into a single, raw array and update the owner.
    try {
      if (parsedAdds.length > 0) await owner.createEmbeddedDocuments(embeddedName, parsedAdds, options);
    } catch (e) {
      logger.error(e);
    } 

    try {
      if (parsedUpdates.length > 0) await owner.updateEmbeddedDocuments(embeddedName, parsedUpdates, options);
    } catch (e) {
      logger.error(e);
    }

    try {
      if (parsedDeletes.length > 0) await owner.deleteEmbeddedDocuments(embeddedName, parsedDeletes, options);
    } catch (e) {
      logger.error(e);
    }

    return true;
  }



  /* 
   * Given an update argument identical to `warpgate.spawn` and a token document, will apply the changes listed in the updates and (by default) store the change delta, which allows these updates to be reverted.  Mutating the same token multiple times will "stack" the delta changes, allowing the user to remove them one-by-one in opposite order of application (last in, first out).
   *
   * @param {TokenDocument} tokenDoc
   *
   * @param {Object = {}} updates. As `warpgate.spawn`.
   *
   * @param {Object = {}} callbacks. Two provided callback locations: delta and post. Both are awaited.
   *   delta {Function(delta, tokenDoc)} Called after the update delta has been generated, but before
   *    it is stored on the actor. Can be used to modify this delta for storage (ex. Current and Max HP 
   *    are increased by 10, but when reverted, you want to keep the extra Current HP applied. 
   *    Update the delta object with the desired HP to return to after revert, or remove it entirely.
   *     @param {Object} delta. Computed change of the actor based on `updates`.
   *     @param {TokenDocument} tokenDoc. Token being modified.
   *   post {Function(tokenDoc, updates)} Called after the actor has been mutated and after the mutate event has triggered. Useful for animations or changes that should not be tracked by the mutation system.
   *     @param {TokenDocument} tokenDoc. Token that has been modified.
   *     @param {Object} updates. See parent `updates` parameter.
   *
   * @param {Object = {}} options
   *   comparisonKeys: {Object = {}}. string-string key-value pairs indicating which field to use for 
   *    comparisons for each needed embeddedDocument type. Ex. From dnd5e: {'ActiveEffect' : 'label'}
   *   permanent: {Boolean = false}. Indicates if this should be treated as a permanent change to 
   *    the actor, which does not store the update delta information required to revert mutation.
   *   name: {String = randomId()}. User provided name, or identifier, for this particular mutation
   *    operation. Used for 'named revert'.
   *   description: {String = options.name}. User provided description (message) that will be displayed 
   *    to the owning user when/if the mutation is requested.
   *   delta: {Object = {}}. The final change to be applied. Overrides 
   *
   * @return {Promise<Object>} The mutation information produced by the provided updates, if they are tracked (i.e. not permanent).
   */
  static async mutate(tokenDoc, updates = {}, callbacks = {}, options = {}) {
    
    /* providing a delta means you are managing the
     * entire data change (including mutation stack changes).
     * Typically used by remote requests */

    /* create a default mutation info assuming we were provided
     * with the final delta already or the change is permanent
     */
    let mutateInfo = Mutator._createMutateInfo( options.delta ?? {}, options );

    /* ensure the options parameter has a name field if not provided */
    options.name = mutateInfo.name;

    /* expand the object to handle property paths correctly */
    updates = expandObject(updates);

    /* permanent changes are not tracked */
    if(!options.permanent) {

      /* if we have the delta provided, trust it */
      let delta = options.delta ?? Mutator._createDelta(tokenDoc, updates, options);

      /* allow user to modify delta if needed (remote updates will never have callbacks) */
      if (callbacks.delta) await callbacks.delta(delta, tokenDoc);

      /* update the mutation info with the final updates including mutate stack info */
      mutateInfo = Mutator._mergeMutateDelta(tokenDoc.actor, delta, updates, options);

      options.delta = delta;
    } 

    if (tokenDoc.actor.isOwner) {

      /* prepare the event data *before* the token is modified */
      const actorData = Comms.packToken(tokenDoc);

      await Mutator._update(tokenDoc, updates, options);

      await warpgate.event.notify(warpgate.EVENT.MUTATE, {actorData, updates});

      if(callbacks.post) await callbacks.post(tokenDoc, updates);

    } else {
      /* this is a remote mutation request, hand it over to that system */
      RemoteMutator.remoteMutate( tokenDoc, {updates, callbacks, options} );
    }

    return mutateInfo;
  }

  static _createMutateInfo( delta, options ) {
    return {
      delta,
      user: game.user.id,
      comparisonKeys: options.comparisonKeys ?? {},
      name: options.name ?? randomID()
    };
  }

  static _mergeMutateDelta(actorDoc, delta, updates, options) {

    /* Grab the current stack (or make a new one) */
    let mutateStack = actorDoc.getFlag(MODULE.data.name, 'mutate') ?? [];

    /* create the information needed to revert this mutation and push
     * it onto the stack
     */
    const mutateInfo = Mutator._createMutateInfo( delta, options );
    mutateStack.push(mutateInfo);

    /* Create a new mutation stack flag data and store it in the update object */
    const flags = {warpgate: {mutate: mutateStack}};
    updates.actor = mergeObject(updates.actor ?? {}, {flags});
    
    return mutateInfo;
  }

  /* @return {Promise} */
  static async _update(tokenDoc, updates, options = {}) {
    /* update the token */
    await tokenDoc.update(updates.token ?? {});

    /* update the actor */
    return Mutator._updateDocument(tokenDoc.actor, updates, options.comparisonKeys ?? {});
  }

  /* Will peel off the last applied mutation change from the provided token document
   * 
   * @param {TokenDocument} tokenDoc. Token document to revert the last applied mutation.
   * @param {String = undefined} mutationName. Specific mutation name to revert. optional.
   *
   * @return {Promise<Object>} The mutation data (updates) used for this revert operation
   */
  static async revertMutation(tokenDoc, mutationName = undefined) {

    if (tokenDoc.actor.isOwner) {

      const mutateData = await Mutator._popMutation(tokenDoc?.actor, mutationName);

      if (!!mutateData) {

        const actorData = Comms.packToken(tokenDoc);

        /* perform the revert with the stored delta */
        await Mutator._update(tokenDoc, mutateData.delta, {comparisonKeys: mutateData.comparisonKeys});

        /* notify clients */
        await warpgate.event.notify(warpgate.EVENT.REVERT, {actorData, updates: mutateData});
        return mutateData;
      }
    } else {
      RemoteMutator.remoteRevert(tokenDoc, mutationName);
    }

    return false;
  }

  

  /* given a token document and the standard update object,
   * parse the changes that need to be applied to *reverse*
   * the mutate operation
   */
  static _createDelta(tokenDoc, updates, options) {

    /* get token changes */
    let tokenData = tokenDoc.data.toObject()
    delete tokenData.actorData;
    
    const tokenDelta = diffObject(updates.token ?? {}, tokenData, {inner:true});

    /* get the actor changes (no embeds) */
    const actorData = Mutator._getRootDocumentData(tokenDoc.actor);
    const actorDelta = diffObject(updates.actor ?? {}, actorData, {inner:true});

    /* get the changes from the embeds */
    let embeddedDelta = {};
    if(updates.embedded) {
      
      for( const embeddedName of Object.keys(updates.embedded) ) {
        const collection = tokenDoc.actor.getEmbeddedCollection(embeddedName);
        const invertedShorthand = Mutator._invertShorthand(collection, updates.embedded[embeddedName], getProperty(options.comparisonKeys, embeddedName) ?? 'name');
        embeddedDelta[embeddedName] = invertedShorthand;
      }
    }

    logger.debug(MODULE.localize('debug.tokenDelta'), tokenDelta, MODULE.localize('debug.actorDelta'), actorDelta, MODULE.localize('debug.embeddedDelta'), embeddedDelta);

    return {token: tokenDelta, actor: actorDelta, embedded: embeddedDelta}
  }

  /* returns the actor data sans ALL embedded collections */
  static _getRootDocumentData(doc) {
    let actorData = doc.toObject();

    /* get the key NAME of the embedded document type.
     * ex. not 'ActiveEffect' (the class name), 'effect' the collection's field name
     */
    const embeddedFields = Object.values(Actor.implementation.metadata.embedded).map( thisClass => thisClass.metadata.collection );

    /* delete any embedded fields from the actor data */
    embeddedFields.forEach( field => { delete actorData[field] } )

    /* do not delta our own delta flags */
    //if (actorData.flags?.warpgate) delete actorData.flags.warpgate

    return actorData;
  }
}
