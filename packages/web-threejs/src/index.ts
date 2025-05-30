/**
 * Copyright 2022-2025 Theai, Inc. dba Inworld AI
 *
 * Use of this source code is governed by the Inworld.ai Software Development Kit License Agreement
 * that can be found in the LICENSE.md file or at https://www.inworld.ai/sdk-license
 */
import { InnequinBehaviorToBody } from './innequin/animator/utils/InnequinBehaviorToBody';
import { InnequinBehaviorToFacial } from './innequin/animator/utils/InnequinBehaviorToFacial';
import { InnequinBodyEmotionToBehavior } from './innequin/animator/utils/InnequinBodyEmotionToBehavior';
import { Innequin, InnequinProps } from './innequin/Innequin';
import {
  InnequinAnimationType,
  InnequinConfiguration,
} from './innequin/InnequinConfiguration';
import { RPMBehaviorToFacial } from './rpm/animator/utils/RPMBehaviorToFacial';
import { RPMBodyEmotionToBehavior } from './rpm/animator/utils/RPMBodyEmotionToBehavior';
import { RPMFacialEmotionMap } from './rpm/animator/utils/RPMFacialEmotionMap';
import { RPM, RPMProps } from './rpm/RPM';
import { RPMAnimationType, RPMConfiguration } from './rpm/RPMConfiguration';
import { SkinType } from './types/types';

export {
  Innequin,
  InnequinBehaviorToBody,
  InnequinBehaviorToFacial,
  InnequinBodyEmotionToBehavior,
  RPM,
  RPMBehaviorToFacial,
  RPMBodyEmotionToBehavior,
  RPMFacialEmotionMap,
};
export type {
  InnequinAnimationType,
  InnequinConfiguration,
  InnequinProps,
  RPMAnimationType,
  RPMConfiguration,
  RPMProps,
  SkinType,
};
