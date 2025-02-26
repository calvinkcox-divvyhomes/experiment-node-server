import { version as PACKAGE_VERSION } from '../../gen/version';
import { FetchHttpClient } from '../transport/http';
import {
  ExperimentConfig,
  RemoteEvaluationDefaults,
  RemoteEvaluationConfig,
} from '../types/config';
import { HttpClient } from '../types/transport';
import { ExperimentUser } from '../types/user';
import { Variant, Variants } from '../types/variant';
import { sleep } from '../util/time';

/**
 * Experiment client for fetching variants for a user remotely.
 * @category Core Usage
 */
export class RemoteEvaluationClient {
  private readonly apiKey: string;
  private readonly httpClient: HttpClient;
  private readonly config: RemoteEvaluationConfig;

  /**
   * Creates a new RemoteEvaluationClient instance.
   *
   * @param apiKey The environment API Key
   * @param config See {@link ExperimentConfig} for config options
   */
  public constructor(apiKey: string, config: RemoteEvaluationConfig) {
    this.apiKey = apiKey;
    this.config = { ...RemoteEvaluationDefaults, ...config };
    this.httpClient = new FetchHttpClient(config?.httpAgent);
  }

  /**
   * Fetch all variants for a user.
   *
   * This method will automatically retry if configured (default).
   *
   * @param user The {@link ExperimentUser} context
   * @return The {@link Variants} for the user on success, empty
   * {@link Variants} on error.
   */
  public async fetch(user: ExperimentUser): Promise<Variants> {
    if (!this.apiKey) {
      throw Error('Experiment API key is empty');
    }
    try {
      return await this.fetchInternal(user);
    } catch (e) {
      console.error('[Experiment] Failed to fetch variants: ', e);
      return {};
    }
  }

  private async fetchInternal(user: ExperimentUser): Promise<Variants> {
    if (!this.apiKey) {
      throw Error('Experiment API key is empty');
    }
    this.debug('[Experiment] Fetching variants for user: ', user);
    try {
      return await this.doFetch(user, this.config.fetchTimeoutMillis);
    } catch (e) {
      console.error('[Experiment] Fetch failed: ', e);
      try {
        return await this.retryFetch(user);
      } catch (e) {
        console.error(e);
      }
      throw e;
    }
  }

  private async doFetch(
    user: ExperimentUser,
    timeoutMillis: number,
  ): Promise<Variants> {
    const userContext = this.addContext(user || {});
    const endpoint = `${this.config.serverUrl}/sdk/vardata`;
    const headers = {
      Authorization: `Api-Key ${this.apiKey}`,
    };
    const body = JSON.stringify(userContext);
    // CDN can only cache requests where the body is < 8KB
    if (body.length > 8000) {
      console.warn(
        `[Experiment] encoded user object length ${body.length} cannot be cached by CDN; must be < 8KB`,
      );
    }
    this.debug('[Experiment] Fetch variants for user: ', userContext);
    const response = await this.httpClient.request(
      endpoint,
      'POST',
      headers,
      body,
      timeoutMillis,
    );
    if (response.status !== 200) {
      throw Error(
        `fetch - received error response: ${response.status}: ${response.body}`,
      );
    }
    const json = JSON.parse(response.body);
    const variants = this.parseJsonVariants(json);
    this.debug('[Experiment] Fetched variants: ', variants);
    return variants;
  }

  private async retryFetch(user: ExperimentUser): Promise<Variants> {
    if (this.config.fetchRetries == 0) {
      return {};
    }
    this.debug('[Experiment] Retrying fetch');
    let err: Error = null;
    let delayMillis = this.config.fetchRetryBackoffMinMillis;
    for (let i = 0; i < this.config.fetchRetries; i++) {
      await sleep(delayMillis);
      try {
        return await this.doFetch(user, this.config.fetchRetryTimeoutMillis);
      } catch (e) {
        console.error('[Experiment] Retry falied: ', e);
        err = e;
      }
      delayMillis = Math.min(
        delayMillis * this.config.fetchRetryBackoffScalar,
        this.config.fetchRetryBackoffMaxMillis,
      );
    }
    throw err;
  }

  private async parseJsonVariants(json: string): Promise<Variants> {
    const variants: Variants = {};
    for (const key of Object.keys(json)) {
      let value: string;
      if ('value' in json[key]) {
        value = json[key].value;
      } else if ('key' in json[key]) {
        // value was previously under the "key" field
        value = json[key].key;
      }
      const variant: Variant = {
        value,
        payload: json[key].payload,
      };
      variants[key] = variant;
    }
    return variants;
  }

  private addContext(user: ExperimentUser): ExperimentUser {
    return {
      library: `experiment-node-server/${PACKAGE_VERSION}`,
      ...user,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private debug(message?: any, ...optionalParams: any[]): void {
    if (this.config.debug) {
      console.debug(message, ...optionalParams);
    }
  }
}

/**
 * @deprecated use {@link RemoteEvaluationClient}.
 */
export class ExperimentClient extends RemoteEvaluationClient {
  constructor(apiKey: string, config: ExperimentConfig) {
    super(apiKey, config);
  }
}
