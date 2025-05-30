import { v4 } from 'uuid';

import { DEFAULT_USER_NAME } from '../common/constants';
import {
  ConversationState,
  InworlControlAction,
  User,
} from '../common/data_structures';
import {
  ConvesationInterface,
  Extension,
} from '../common/data_structures/extension';
import {
  CHAT_HISTORY_TYPE,
  HistoryInteractionEnd,
  HistoryItem,
  HistoryItemActor,
  HistoryItemConversationUpdate,
  HistoryItemLogEvent,
  HistoryItemNarratedAction,
  HistoryItemSceneChange,
  HistoryItemTaskEvent,
  HistoryItemTriggerEvent,
} from '../common/data_structures/history';
import { Character } from '../entities/character.entity';
import { EmotionEvent } from '../entities/packets/emotion/emotion.entity';
import { InworldPacket } from '../entities/packets/inworld_packet.entity';
import { Actor } from '../entities/packets/routing.entity';
import { GrpcAudioPlayback } from './sound/grpc_audio.playback';

interface InworldHistoryAddProps<InworldPacketT> {
  characters: Character[];
  grpcAudioPlayer: GrpcAudioPlayback;
  packet: InworldPacketT;
  outgoing?: boolean;
  fromHistory?: boolean;
  fromHistoryCharacter?: Character;
}

interface EmotionsMap {
  [key: string]: EmotionEvent;
}

interface InworldHistoryProps<
  InworldPacketT extends InworldPacket = InworldPacket,
  HistoryItemT extends HistoryItem = HistoryItem,
> {
  audioEnabled?: boolean;
  extension?: Extension<InworldPacketT, HistoryItemT>;
  user?: User;
  scene: string;
  conversations: Map<
    string,
    {
      service: ConvesationInterface<InworldPacketT>;
      state: ConversationState;
    }
  >;
}

interface ConversationItem {
  packet: InworldPacket;
  isApplied: boolean;
}

export class InworldHistory<
  InworldPacketT extends InworldPacket = InworldPacket,
  HistoryItemT extends HistoryItem = HistoryItem,
> {
  private audioEnabled: boolean;
  private audioEnabledPerConversation: Record<string, boolean> = {};
  private scene: string;
  private user?: User;
  private history: HistoryItem[] = [];
  private queue: HistoryItem[] = [];
  private emotions: EmotionsMap = {};
  private extension: Extension<InworldPacketT, HistoryItemT> | undefined;
  private conversationItems: ConversationItem[] = [];
  private conversations: Map<
    string,
    {
      service: ConvesationInterface<InworldPacketT>;
      state: ConversationState;
    }
  >;

  constructor(props: InworldHistoryProps<InworldPacketT, HistoryItemT>) {
    if (props.extension) {
      this.extension = props.extension;
    }

    if (props.user) {
      this.user = props.user;
    }

    this.scene = props?.scene;
    this.conversations = props.conversations;
    this.audioEnabled = props.audioEnabled ?? false;
  }

  setAudioEnabled(conversationId: string, enabled: boolean) {
    this.audioEnabledPerConversation[conversationId] = enabled;
  }

  addOrUpdate({
    characters,
    grpcAudioPlayer,
    packet,
    outgoing,
    fromHistory = false,
    fromHistoryCharacter,
  }: InworldHistoryAddProps<InworldPacketT>) {
    let historyItem: HistoryItem | undefined;
    let queueItem: HistoryItem | undefined;
    let needToDisplay: HistoryItem[] = [];

    const utteranceId = packet.packetId.utteranceId;
    const interactionId = packet.packetId.interactionId;
    const conversationId = packet.packetId.conversationId;

    switch (true) {
      case packet.isAudio():
        this.conversationItems.push({ packet, isApplied: false });
        break;

      case packet.isEmotion():
        this.emotions[interactionId] = packet.emotions;
        break;

      case packet.isText():
      case packet.isNarratedAction():
        const itemCharacters = this.findCharacters(characters, { packet });
        const packetCharacters =
          fromHistory && fromHistoryCharacter && itemCharacters.length === 0
            ? [fromHistoryCharacter]
            : itemCharacters;
        const textItem: HistoryItem = packet.isText()
          ? {
              ...this.combineTextItem(packet),
              character: packetCharacters[0],
              characters: packetCharacters,
              fromHistory,
            }
          : {
              ...this.combineNarratedActionItem(
                packet,
                packetCharacters,
                this.user,
              ),
              fromHistory,
              conversationId,
            };

        const audioIsApplied = !!this.conversationItems.find(
          (item: ConversationItem) =>
            !!item.packet.isAudio() &&
            item.isApplied &&
            item.packet.packetId.utteranceId === utteranceId,
        );
        const audioIsEnabled =
          this.audioEnabledPerConversation[conversationId] ?? this.audioEnabled;

        if (
          audioIsApplied ||
          fromHistory ||
          packet.routing.source.isPlayer ||
          !audioIsEnabled
        ) {
          historyItem = textItem;
        } else {
          queueItem = textItem;
        }
        break;

      case packet.isTrigger():
      case packet.isTask():
        historyItem = {
          ...this.combineCustomItem(packet, outgoing),
          fromHistory,
          conversationId,
        };
        break;

      case packet.isLog():
        historyItem = {
          ...this.combineLogItem(packet),
          fromHistory,
        };
        break;

      case packet.isInteractionEnd():
        const controlItem: HistoryInteractionEnd = {
          ...this.combineInteractionEndItem(packet),
          conversationId,
        };

        if (
          this.audioEnabled &&
          grpcAudioPlayer.hasPacketInQueue({ interactionId })
        ) {
          queueItem = controlItem;
        } else {
          needToDisplay = [...this.queue].filter(
            (item) => item.interactionId === interactionId,
          );
          this.history = [...this.history, ...needToDisplay];
          this.queue = this.queue.filter(
            (item) => item.interactionId !== interactionId,
          );
          historyItem = controlItem;
        }
        break;

      case packet.isSceneMutationRequest():
        queueItem = this.combineSceneChangeItem(packet, characters);
        break;

      case packet.isSceneMutationResponse():
        const sceneMutation = this.queue.findLast(
          (item) => item.type === CHAT_HISTORY_TYPE.SCENE_CHANGE,
        ) as HistoryItemSceneChange;

        if (sceneMutation) {
          const added =
            packet.sceneMutation.loadedCharacters?.filter((l) =>
              sceneMutation.addedCharacters.find(
                (c) => c.resourceName === l.resourceName,
              ),
            ) ?? [];

          sceneMutation.loadedCharacters =
            packet.sceneMutation.loadedCharacters;
          sceneMutation.addedCharacters = added;

          this.history = [...this.history, ...[sceneMutation]];
          this.queue = this.queue.filter(
            (item) => item.type !== CHAT_HISTORY_TYPE.SCENE_CHANGE,
          );
        }

        return sceneMutation ? [sceneMutation] : [];

      case packet.control?.action === InworlControlAction.CONVERSATION_UPDATE:
        const conversation = this.conversations.get(conversationId);
        this.queue.push({
          ...this.combineConversationUpdateItem(packet),
          currentCharacters: conversation.service?.getCharacters(),
        });
        break;

      case packet.control?.action === InworlControlAction.CONVERSATION_EVENT:
        const updateItem = this.queue.find(
          (item) =>
            item.type === CHAT_HISTORY_TYPE.CONVERSATION_UPDATE &&
            item.conversationId === packet.packetId.conversationId,
        ) as HistoryItemConversationUpdate;

        if (updateItem) {
          const addedPatricipants =
            packet.control.conversation.participants.filter(
              (participant) =>
                !updateItem.currentCharacters?.find(
                  (character) => character.id === participant.name,
                ),
            );
          const addedCharacters = this.findCharacters(characters, {
            participants: addedPatricipants,
          });
          const removedCharacters = updateItem.currentCharacters.filter(
            (character) =>
              !packet.control.conversation.participants?.find(
                (participant) => character.id === participant.name,
              ),
          );

          this.queue = this.queue.filter(
            (item) =>
              item.type !== CHAT_HISTORY_TYPE.CONVERSATION_UPDATE ||
              item.conversationId !== packet.packetId.conversationId,
          );

          if (addedCharacters.length || removedCharacters.length) {
            const diff = {
              ...updateItem,
              addedCharacters,
              removedCharacters,
            };
            this.history = [...this.history, ...[diff]];

            return [diff];
          }
          return [];
        }
    }

    if (historyItem) {
      const currentHistoryIndex = this.history.findIndex((item) => {
        return item.id === historyItem.id && item.type === historyItem.type;
      });

      const item = this.convertToExtendedType(packet, historyItem);

      if (currentHistoryIndex >= 0) {
        this.history[currentHistoryIndex] = {
          ...this.history[currentHistoryIndex],
          ...item,
        };
      } else {
        this.history = [...this.history, item!];
      }
    }

    if (queueItem) {
      this.queue = [
        ...this.queue,
        this.convertToExtendedType(packet, queueItem),
      ];
    }

    return historyItem ? [...needToDisplay, historyItem] : [];
  }

  update(packet: InworldPacketT) {
    if (packet.isText()) {
      let text: HistoryItemActor;
      const currentHistoryIndex = this.history.findIndex(
        (item) => item.id === packet.packetId.utteranceId,
      );

      if (currentHistoryIndex >= 0) {
        text = this.combineTextItem(packet);
        this.history[currentHistoryIndex] = {
          ...this.history[currentHistoryIndex],
          ...text,
        };

        return [text];
      }
    } else if (packet.isAudio()) {
      this.markAsApplied(
        (item) =>
          item.isAudio() &&
          item.packetId.utteranceId === packet.packetId.utteranceId,
      );

      const toDisplay = this.display(packet);

      if (
        toDisplay.find(
          (item) => item.type === CHAT_HISTORY_TYPE.INTERACTION_END,
        )
      ) {
        this.conversationItems = this.conversationItems.filter(
          (item: ConversationItem) =>
            item.packet.packetId.interactionId !==
            packet.packetId.interactionId,
        );
      }

      return toDisplay;
    }

    return [];
  }

  display(packet: InworldPacketT) {
    const types = [
      CHAT_HISTORY_TYPE.ACTOR,
      CHAT_HISTORY_TYPE.INTERACTION_END,
      CHAT_HISTORY_TYPE.NARRATED_ACTION,
    ];
    const found = this.queue.filter(
      (item) =>
        types.includes(item.type) &&
        item.interactionId === packet.packetId.interactionId,
    );
    const toDisplay: HistoryItem[] = [];

    if (found.length) {
      for (const item of found) {
        if (
          (item.type === CHAT_HISTORY_TYPE.ACTOR &&
            item.id === packet.packetId.utteranceId) ||
          item.type === CHAT_HISTORY_TYPE.NARRATED_ACTION
        ) {
          toDisplay.push(item);
        }
      }

      if (
        toDisplay.length + 1 === found.length &&
        found[found.length - 1].type === CHAT_HISTORY_TYPE.INTERACTION_END
      ) {
        toDisplay.push(found[found.length - 1]);
      }
    }

    this.queue = this.queue.filter(
      (item) => !toDisplay.find((x) => x.id === item.id),
    );
    this.history = [...this.history, ...toDisplay];

    return toDisplay;
  }

  get(conversationId?: string) {
    if (!conversationId) {
      return this.history;
    }

    return this.history.filter(
      (item) => item.conversationId === conversationId,
    );
  }

  filter(props: {
    history?: (item: HistoryItem) => boolean;
    queue?: (item: HistoryItem) => boolean;
  }) {
    if (props.history) {
      this.history = this.history.filter(props.history);
    }

    if (props.queue) {
      this.queue = this.queue.filter(props.queue);
    }

    return this.history;
  }

  clear() {
    this.queue = [];
    this.history = [];
  }

  getTranscript(conversationId?: string): string {
    const history = this.get(conversationId);

    if (!history.length) {
      return '';
    }

    let transcript = '';
    let characterLastSpeaking = false;

    history.forEach((item) => {
      const prefix = transcript.length ? '\n' : '';
      switch (item.type) {
        case CHAT_HISTORY_TYPE.ACTOR:
        case CHAT_HISTORY_TYPE.NARRATED_ACTION:
          const isCharacter = item.source.isCharacter;
          const givenName = isCharacter
            ? item.character.displayName
            : this.getUserName(this.user);
          const emotionCode =
            (isCharacter &&
              this.emotions[item.interactionId]?.behavior?.code) ||
            '';
          const emotion = emotionCode ? `(${emotionCode}) ` : '';

          const text =
            item.type === CHAT_HISTORY_TYPE.NARRATED_ACTION
              ? `*${item.text}*`
              : item.text;
          transcript +=
            characterLastSpeaking && isCharacter
              ? `${
                  transcript?.[transcript.length - 1] === ' ' ? '' : ' '
                }${text}`
              : `${prefix}${givenName}: ${emotion}${text}`;
          characterLastSpeaking = isCharacter;
          break;
        case CHAT_HISTORY_TYPE.TRIGGER_EVENT:
        case CHAT_HISTORY_TYPE.TASK_EVENT:
          transcript += `${prefix}>>> ${item.name}`;
          characterLastSpeaking = false;
          break;
        case CHAT_HISTORY_TYPE.SCENE_CHANGE:
          transcript += `${prefix}${prefix}>>> Now moving to ${item.to}`;
          characterLastSpeaking = false;
          break;
      }
    });

    return transcript;
  }

  private getUserName(user?: User) {
    return user?.fullName || DEFAULT_USER_NAME;
  }

  private combineTextItem(packet: InworldPacketT): HistoryItemActor {
    return {
      id: packet.packetId.utteranceId,
      isRecognizing: !packet.text.final,
      scene: this.scene,
      type: CHAT_HISTORY_TYPE.ACTOR,
      text: packet.text.text,
      date: new Date(packet.date),
      correlationId: packet.packetId.correlationId,
      conversationId: packet.packetId.conversationId,
      interactionId: packet.packetId.interactionId,
      source: packet.routing.source,
    };
  }

  private combineSceneChangeItem(
    packet: InworldPacketT,
    characters: Character[],
  ): HistoryItemSceneChange {
    const removedCharacters = packet.sceneMutation.removedCharacterIds?.length
      ? characters.filter(
          (character) =>
            !packet.sceneMutation.removedCharacterIds?.find(
              (id) => character.id === id,
            ),
        )
      : [];

    return {
      id: v4(),
      date: new Date(packet.date),
      interactionId: packet.packetId.interactionId,
      type: CHAT_HISTORY_TYPE.SCENE_CHANGE,
      source: packet.routing.source,
      ...(packet.sceneMutation?.name && {
        to: packet.sceneMutation.name,
        description: packet.sceneMutation.description,
        displayName: packet.sceneMutation.displayName,
      }),
      loadedCharacters: [],
      addedCharacters:
        packet.sceneMutation.addedCharacterNames?.map(
          (resourceName) => ({ resourceName }) as Character,
        ) || [],
      removedCharacters,
    };
  }

  private combineConversationUpdateItem(
    packet: InworldPacketT,
  ): HistoryItemConversationUpdate {
    return {
      id: v4(),
      date: new Date(packet.date),
      type: CHAT_HISTORY_TYPE.CONVERSATION_UPDATE,
      source: packet.routing.source,
      conversationId: packet.packetId.conversationId,
    };
  }

  private combineNarratedActionItem(
    packet: InworldPacketT,
    characters: Character[],
    user?: User,
  ): HistoryItemNarratedAction {
    let text = packet.narratedAction.text;

    if (packet.routing.source.isPlayer) {
      text = text.replaceAll('{player}', this.getUserName(user));

      if (characters.length) {
        text = text.replaceAll('{character}', characters[0].displayName);
      }
    }

    return {
      id: packet.packetId.utteranceId,
      date: new Date(packet.date),
      scene: this.scene,
      character: characters[0],
      characters,
      interactionId: packet.packetId.interactionId,
      conversationId: packet.packetId.conversationId,
      source: packet.routing.source,
      type: CHAT_HISTORY_TYPE.NARRATED_ACTION,
      text,
    };
  }

  private combineCustomItem(
    packet: InworldPacketT,
    outgoing?: boolean,
  ): HistoryItemTriggerEvent | HistoryItemTaskEvent {
    return {
      id: packet.packetId.utteranceId,
      scene: this.scene,
      date: new Date(packet.date),
      interactionId: packet.packetId.interactionId,
      conversationId: packet.packetId.conversationId,
      correlationId: packet.packetId.correlationId,
      outgoing,
      source: packet.routing.source,
      ...(packet.isTrigger()
        ? {
            type: CHAT_HISTORY_TYPE.TRIGGER_EVENT,
            name: packet.trigger.name,
            parameters: packet.trigger.parameters,
          }
        : {
            type: CHAT_HISTORY_TYPE.TASK_EVENT,
            name: packet.task.name,
            parameters: packet.task.parameters,
          }),
    };
  }

  private combineInteractionEndItem(
    packet: InworldPacketT,
  ): HistoryInteractionEnd {
    return {
      id: v4(),
      date: new Date(packet.date),
      interactionId: packet.packetId.interactionId,
      conversationId: packet.packetId.conversationId,
      scene: this.scene,
      source: packet.routing.source,
      type: CHAT_HISTORY_TYPE.INTERACTION_END,
    };
  }

  private combineLogItem(packet: InworldPacketT): HistoryItemLogEvent {
    return {
      id: packet.packetId.utteranceId,
      scene: this.scene,
      conversationId: packet.packetId.conversationId,
      date: new Date(packet.date),
      interactionId: packet.packetId.interactionId,
      level: packet.log.level,
      metadata: packet.log.metadata,
      details: packet.log.details,
      source: packet.routing.source,
      text: packet.log.text,
      type: CHAT_HISTORY_TYPE.LOG_EVENT,
    };
  }

  private convertToExtendedType(packet: InworldPacketT, item: HistoryItem) {
    return this.extension?.historyItem?.(packet, item) || item;
  }

  private markAsApplied = (compare: (item: InworldPacket) => Boolean) => {
    const found = this.conversationItems.find(
      (item: ConversationItem) => !item.isApplied && compare(item.packet),
    );

    if (found) {
      found.isApplied = true;
    }

    return found;
  };

  private findCharacters(
    characters: Character[],
    props: { packet?: InworldPacketT; participants?: Actor[] },
  ): Character[] {
    const { packet, participants = [] } = props;

    const byId = characters.reduce(
      (acc, character) => {
        acc[character.id] = character;
        return acc;
      },
      {} as { [key: string]: Character },
    );

    if (!!packet) {
      if (packet.routing.source.isCharacter) {
        return byId[packet.routing.source.name]
          ? [byId[packet.routing.source.name]]
          : [];
      }

      if (packet.routing.targets.length) {
        return packet.routing.targets
          .filter((x) => x.isCharacter && byId[x.name])
          .map((x) => byId[x.name]);
      }

      const conversation = this.conversations.get(
        packet.packetId.conversationId,
      );

      return conversation?.service?.getCharacters() || [];
    } else {
      return participants
        .filter((x) => x.isCharacter && byId[x.name])
        .map((x) => byId[x.name]);
    }
  }
}
