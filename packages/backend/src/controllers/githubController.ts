import {
    ApiSuccessEmpty,
    ForbiddenError,
    GitRepo,
    NotFoundError,
} from '@lightdash/common';
import { Octokit as OctokitRest } from '@octokit/rest';
import {
    Delete,
    Get,
    Middlewares,
    OperationId,
    Query,
    Request,
    Route,
    SuccessResponse,
} from '@tsoa/runtime';
import express from 'express';
import { nanoid, urlAlphabet } from 'nanoid';
import { getGithubApp, getOctokitRestForApp } from '../clients/github/Github';
import { lightdashConfig } from '../config/lightdashConfig';
import { isAuthenticated, unauthorisedInDemo } from './authentication';
import { BaseController } from './baseController';

/** HOW it works
 *
 * First install the app in the org
 * using /api/v1/github/install
 *
 * This will redirect to the github app to the callback page
 * Write down the refresh token (not sure if we need it) and installation_id (currently hardcoded)
 *
 * and then you can use it on /api/v1/github/list
 * or /api/v1/github/create-branch to create a branch and push some code.
 */
@Route('/api/v1/github')
export class GithubInstallController extends BaseController {
    /**
     * Install the Lightdash GitHub App and link to an organization
     *
     * @param redirect The url to redirect to after installation
     * @param req express request
     */
    @Middlewares([isAuthenticated, unauthorisedInDemo])
    @SuccessResponse('302', 'Not found')
    @Get('/install')
    @OperationId('installGithubAppForOrganization')
    async installGithubAppForOrganization(
        @Request() req: express.Request,
    ): Promise<void> {
        const returnToUrl = new URL(
            '/generalSettings/integrations',
            lightdashConfig.siteUrl,
        );
        const randomID = nanoid().replace('_', ''); // we use _ as separator, don't allow this character on the nanoid
        const subdomain = lightdashConfig.github.redirectDomain;
        const state = `${subdomain}_${randomID}`;
        const githubAppName = lightdashConfig.github.appName;

        req.session.oauth = {};
        req.session.oauth.returnTo = returnToUrl.href;
        req.session.oauth.state = state;
        req.session.oauth.inviteCode = req.user!.userUuid;

        this.setStatus(302);
        this.setHeader(
            'Location',
            `https://github.com/apps/${githubAppName}/installations/new?state=${state}`,
        );
    }

    /**
     * Callback URL for GitHub App Authorization also used for GitHub App Installation with combined Authorization
     *
     * @param req {express.Request} express request
     * @param code {string} authorization code from GitHub
     * @param state {string} oauth state parameter
     * @param installation_id {string} installation id from GitHub
     * @param setup_action {string} setup action from GitHub
     */
    @Get('/oauth/callback')
    @OperationId('githubOauthCallback')
    async githubOauthCallback(
        @Request() req: express.Request,
        @Query() code?: string,
        @Query() state?: string,
        @Query() installation_id?: string,
        @Query() setup_action?: string,
    ): Promise<void> {
        if (!state || state !== req.session.oauth?.state) {
            this.setStatus(400);
            throw new Error('State does not match');
        }
        if (setup_action === 'review') {
            // User attempted to setup the app, didn't have permission in GitHub and sent a request to the admins
            // We can't do anything at this point
            this.setStatus(200);
        }

        const userUuid = req.session.oauth.inviteCode;
        if (!userUuid) {
            this.setStatus(400);
            throw new Error('User uuid not provided');
        }

        if (!installation_id) {
            this.setStatus(400);
            throw new Error('Installation id not provided');
        }
        if (code) {
            const userToServerToken = await getGithubApp().oauth.createToken({
                code,
            });

            const { token, refreshToken } = userToServerToken.authentication;
            if (refreshToken === undefined)
                throw new ForbiddenError('Invalid authentication token');

            // Verify installation
            const response =
                await new OctokitRest().apps.listInstallationsForAuthenticatedUser(
                    {
                        headers: {
                            authorization: `Bearer ${token}`,
                        },
                    },
                );
            const installation = response.data.installations.find(
                (i) => `${i.id}` === installation_id,
            );
            if (installation === undefined)
                throw new Error('Invalid installation id');

            await this.services
                .getGithubAppService()
                .upsertInstallation(
                    userUuid,
                    installation_id,
                    token,
                    refreshToken,
                );
            const redirectUrl = new URL(req.session.oauth?.returnTo || '/');
            req.session.oauth = {};
            this.setStatus(302);
            this.setHeader('Location', redirectUrl.href);
        }
    }

    @Middlewares([isAuthenticated, unauthorisedInDemo])
    @Delete('/uninstall')
    @OperationId('uninstallGithubAppForOrganization')
    async uninstallGithubAppForOrganization(
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        await this.services
            .getGithubAppService()
            .deleteAppInstallation(req.user!);

        this.setStatus(200);
        return {
            status: 'ok',
            results: undefined,
        };
    }

    @Middlewares([isAuthenticated, unauthorisedInDemo])
    @SuccessResponse('200')
    @Get('/repos/list')
    @OperationId('getGithubListRepositories')
    async getGithubListRepositories(@Request() req: express.Request): Promise<{
        status: 'ok';
        results: Array<GitRepo>;
    }> {
        this.setStatus(200);

        return {
            status: 'ok',
            results: await this.services
                .getGithubAppService()
                .getRepos(req.user!),
        };
    }
}
