import Vue, { CreateElement, VNode, VueConstructor } from 'vue';
import { values, findIndex, warn, createFlags, debounce } from '../utils';
import {
  ValidationResult,
  InactiveRefCache,
  VeeObserver,
  VNodeWithVeeContext,
  ValidationFlags,
  KnownKeys
} from '../types';
import { ValidationProvider } from './Provider';
import { normalizeChildren } from '../utils/vnode';

const FLAGS_STRATEGIES: [KnownKeys<ValidationFlags>, 'every' | 'some'][] = [
  ['pristine', 'every'],
  ['dirty', 'some'],
  ['touched', 'some'],
  ['untouched', 'every'],
  ['valid', 'every'],
  ['invalid', 'some'],
  ['pending', 'some'],
  ['validated', 'every'],
  ['changed', 'some'],
  ['passed', 'every'],
  ['failed', 'some']
];

type ProviderInstance = InstanceType<typeof ValidationProvider>;
type ObserverErrors = Record<string, string[]>;

let OBSERVER_COUNTER = 0;

function data() {
  const refs: Record<string, ProviderInstance> = {};
  const inactiveRefs: Record<string, InactiveRefCache> = {};
  const errors: ObserverErrors = {};
  const flags: ValidationFlags = {} as ValidationFlags;
  // FIXME: Not sure of this one can be typed, circular type reference.
  const observers: any[] = [];

  return {
    id: '',
    refs,
    observers,
    inactiveRefs,
    errors,
    flags
  };
}

type withObserverNode = VueConstructor<
  Vue & {
    $_veeObserver: VeeObserver;
    $vnode: VNodeWithVeeContext;
  }
>;

export const ValidationObserver = (Vue as withObserverNode).extend({
  name: 'ValidationObserver',
  provide() {
    return {
      $_veeObserver: this
    };
  },
  inject: {
    $_veeObserver: {
      from: '$_veeObserver',
      default() {
        if (!this.$vnode.context.$_veeObserver) {
          return null;
        }

        return this.$vnode.context.$_veeObserver;
      }
    }
  },
  props: {
    tag: {
      type: String,
      default: 'span'
    },
    vid: {
      type: String,
      default() {
        return `obs_${OBSERVER_COUNTER++}`;
      }
    },
    slim: {
      type: Boolean,
      default: false
    },
    disabled: {
      type: Boolean,
      default: false
    }
  },
  data,
  created() {
    this.id = this.vid;
    register.call(this);

    const onChange = debounce(({ errors, flags }: { errors: ObserverErrors; flags: ValidationFlags }) => {
      this.errors = errors;
      this.flags = flags;
    }, 16);

    this.$watch(
      () => {
        const vms = [...values(this.refs), ...values(this.inactiveRefs), ...this.observers];
        const errors: ObserverErrors = {};
        const flags: ValidationFlags = {} as ValidationFlags;

        const length = vms.length;
        for (let i = 0; i < length; i++) {
          const vm = vms[i];
          errors[vm.id] = vm.errors;
        }

        FLAGS_STRATEGIES.forEach(([flag, method]) => {
          flags[flag] = vms[method](vm => vm.flags[flag]);
        });

        return { errors, flags };
      },
      onChange as any
    );
  },
  activated: register,
  deactivated: unregister,
  beforeDestroy: unregister,
  render(h: CreateElement): VNode {
    const children = normalizeChildren(this, prepareSlotProps(this));

    return this.slim && children.length <= 1 ? children[0] : h(this.tag, { on: this.$listeners }, children);
  },
  methods: {
    subscribe(this: any, subscriber: any, kind = 'provider') {
      if (kind === 'observer') {
        this.observers.push(subscriber);
        return;
      }

      this.refs = { ...this.refs, ...{ [subscriber.id]: subscriber } };
      if (subscriber.persist) {
        this.restoreProviderState(subscriber);
      }
    },
    unsubscribe(this: any, id: string, kind = 'provider') {
      if (kind === 'provider') {
        this.removeProvider(id);
        return;
      }

      const idx = findIndex(this.observers, (o: any) => o.id === id);
      if (idx !== -1) {
        this.observers.splice(idx, 1);
      }
    },
    async validate({ silent = false }: { silent?: boolean } = {}) {
      const results = await Promise.all([
        ...values(this.refs)
          .filter(r => !r.disabled)
          .map((ref: any) => ref[silent ? 'validateSilent' : 'validate']().then((r: ValidationResult) => r.valid)),
        ...this.observers.filter(o => !o.disabled).map((obs: any) => obs.validate({ silent }))
      ]);

      return results.every(r => r);
    },
    async passes(this: any, cb: Function) {
      const isValid = await this.validate();
      if (!isValid || !cb) {
        return;
      }

      return cb();
    },
    reset() {
      Object.keys(this.inactiveRefs).forEach(key => {
        this.$delete(this.inactiveRefs, key);
      });

      return [...values(this.refs), ...this.observers].forEach(ref => ref.reset());
    },
    restoreProviderState(provider: ProviderInstance) {
      const id = provider.id;
      const state = this.inactiveRefs[id];
      if (!state) {
        return;
      }

      provider.setFlags(state.flags);
      provider.applyResult(state);
      this.$delete(this.inactiveRefs, provider.id);
    },
    removeProvider(id: string) {
      const provider = this.refs[id];
      if (!provider) {
        // FIXME: inactive refs are not being cleaned up.
        return;
      }

      if (provider.persist) {
        /* istanbul ignore next */
        if (process.env.NODE_ENV !== 'production') {
          if (id.indexOf('_vee_') === 0) {
            warn(
              'Please provide a `vid` or a `name` prop when using `persist`, there might be unexpected issues otherwise.'
            );
          }
        }

        // save it for the next time.
        this.inactiveRefs[id] = {
          id,
          flags: provider.flags,
          errors: provider.errors,
          failedRules: provider.failedRules
        };
      }

      this.$delete(this.refs, id);
    },
    setErrors(errors: Record<string, string[]>) {
      Object.keys(errors).forEach(key => {
        const provider = this.refs[key];
        if (!provider) return;

        provider.setErrors(errors[key] || []);
      });

      this.observers.forEach((observer: any) => {
        observer.setErrors(errors);
      });
    }
  }
});

function unregister(this: any) {
  if (this.$_veeObserver) {
    this.$_veeObserver.unsubscribe(this.id, 'observer');
  }
}

function register(this: any) {
  if (this.$_veeObserver) {
    this.$_veeObserver.subscribe(this, 'observer');
  }
}

function prepareSlotProps(vm: any) {
  return {
    ...vm.flags,
    errors: vm.errors,
    validate: vm.validate,
    passes: vm.passes,
    reset: vm.reset
  };
}
