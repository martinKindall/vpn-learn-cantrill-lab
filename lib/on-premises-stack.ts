import { Stack, StackProps, Tags, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class OnPremisesStack extends Stack {
  private vpc: ec2.Vpc;
  private pubSubnet: ec2.ISubnet;
  private priv1Subnet: ec2.ISubnet;
  private priv2Subnet: ec2.ISubnet;
  private ec2Role: iam.Role;
  private securityGroup: ec2.SecurityGroup;
  private eniR1Private: ec2.CfnNetworkInterface;
  private eniR2Private: ec2.CfnNetworkInterface;
  private publicRT: ec2.CfnRouteTable;
  private priv1RT: ec2.CfnRouteTable;
  private priv2RT: ec2.CfnRouteTable;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpcSetup();
    this.createEc2Role();
    const {router1, router2} = this.routerAndServersSetups();
    this.outputs(router1, router2);
  }

  private vpcSetup() {
    this.vpc = new ec2.Vpc(this, 'onprem_vpc', {
      cidr: '192.168.8.0/21',
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [],
    });
    Tags.of(this.vpc).add('Name', 'ONPREM');

    const internetGW = new ec2.CfnInternetGateway(this, 'IGW', {
      tags: [{key: 'Name', value: 'IGW-ONPREM'}]
    });

    const vpcIgwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'vpcIgwAttachment', {
      vpcId: this.vpc.vpcId,
      internetGatewayId: internetGW.attrInternetGatewayId
    });

    const pubSubnetAZ = this.availabilityZones[0];
    const pubSubnet = new ec2.CfnSubnet(this, 'pubSubnet', {
      mapPublicIpOnLaunch: true,
      vpcId: this.vpc.vpcId,
      availabilityZone: pubSubnetAZ,
      cidrBlock: '192.168.12.0/24',
      tags: [{key: 'Name', value: 'ONPREM-PUBLIC'}]
    });

    const priv1Subnet = new ec2.CfnSubnet(this, 'priv1Subnet', {
      vpcId: this.vpc.vpcId,
      availabilityZone: pubSubnetAZ,
      cidrBlock: '192.168.10.0/24',
      tags: [{key: 'Name', value: 'ONPREM-PRIVATE-1'}]
    });

    const priv2Subnet = new ec2.CfnSubnet(this, 'priv2Subnet', {
      vpcId: this.vpc.vpcId,
      availabilityZone: pubSubnetAZ,
      cidrBlock: '192.168.11.0/24',
      tags: [{key: 'Name', value: 'ONPREM-PRIVATE-2'}]
    });

    this.publicRT = new ec2.CfnRouteTable(this, 'publicRT', {
      vpcId: this.vpc.vpcId,
      tags: [{key: 'Name', value: 'ONPREM-PUBLIC-RT'}]
    });

    this.pubSubnet = ec2.Subnet.fromSubnetAttributes(this, 'importedPubSubnet', {
      subnetId: pubSubnet.attrSubnetId,
      routeTableId: this.publicRT.attrRouteTableId,
      availabilityZone: pubSubnetAZ
    });

    const defaultRoute = new ec2.CfnRoute(this, 'defaultRoute', {
      gatewayId: internetGW.attrInternetGatewayId,
      routeTableId: this.publicRT.attrRouteTableId,
      destinationCidrBlock: '0.0.0.0/0',
    }).addDependsOn(vpcIgwAttachment);

    this.priv1RT = new ec2.CfnRouteTable(this, 'priv1RT', {
      vpcId: this.vpc.vpcId,
      tags: [{key: 'Name', value: 'ONPREM-PRIVATE-RT1'}]
    });

    this.priv2RT = new ec2.CfnRouteTable(this, 'priv2RT', {
      vpcId: this.vpc.vpcId,
      tags: [{key: 'Name', value: 'ONPREM-PRIVATE-RT2'}]
    });

    this.priv1Subnet = ec2.Subnet.fromSubnetAttributes(this, 'importedPriv1Subnet', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: this.priv1RT.attrRouteTableId,
      availabilityZone: pubSubnetAZ
    });

    this.priv2Subnet = ec2.Subnet.fromSubnetAttributes(this, 'importedPriv2Subnet', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: this.priv2RT.attrRouteTableId,
      availabilityZone: pubSubnetAZ
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: this.vpc,
      description: 'Default ONPREM SG'
    });
    this.securityGroup.addIngressRule(ec2.Peer.ipv4('10.16.0.0/16'), ec2.Port.allTraffic(), 'Allow All from AWS Environment');

    const securityGroupIngress = new ec2.CfnSecurityGroupIngress(this, 'SecurityGroupIngress', {
      groupId: this.securityGroup.securityGroupId,
      ipProtocol: '-1',
      sourceSecurityGroupId: this.securityGroup.securityGroupId,
      description: 'Allow porters of this security group to access other resources using the same SG under any protocol.'
    });

    this.eniR1Private = new ec2.CfnNetworkInterface(this, 'eniR1Private', {
      subnetId: priv1Subnet.attrSubnetId,
      description: 'Router1 PRIVATE INTERFACE',
      groupSet: [this.securityGroup.securityGroupId],
      sourceDestCheck: false,
      tags: [{key: 'Name', value: 'ONPREM-ENI1-PRIVATE'}]
    });

    this.eniR2Private = new ec2.CfnNetworkInterface(this, 'eniR2Private', {
      subnetId: priv2Subnet.attrSubnetId,
      description: 'Router2 PRIVATE INTERFACE',
      groupSet: [this.securityGroup.securityGroupId],
      sourceDestCheck: false,
      tags: [{key: 'Name', value: 'ONPREM-ENI2-PRIVATE'}]
    });

    const route1AwsIpv4 = new ec2.CfnRoute(this, 'route1AwsIpv4', {
      routeTableId: this.priv1RT.attrRouteTableId,
      destinationCidrBlock: '10.16.0.0/16',
      networkInterfaceId: this.eniR1Private.attrId
    });

    const route2AwsIpv4 = new ec2.CfnRoute(this, 'route2AwsIpv4', {
      routeTableId: this.priv2RT.attrRouteTableId,
      destinationCidrBlock: '10.16.0.0/16',
      networkInterfaceId: this.eniR2Private.attrId
    });

    const defaultRTToPubAssociation = new ec2.CfnSubnetRouteTableAssociation(this, 'defaultRTToPubAssociation', {
      subnetId: pubSubnet.attrSubnetId,
      routeTableId: this.publicRT.attrRouteTableId
    });

    const rtToPriv1Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv1Association', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: this.priv1RT.attrRouteTableId
    });

    const rtToPriv2Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv2Association', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: this.priv2RT.attrRouteTableId
    });
  }

  private routerAndServersSetups() {
    const ssmInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ssmEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.pubSubnet]
      },
      securityGroups: [this.securityGroup]
    });

    const ssmEc2MessagesInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ssmEc2MessagesEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.pubSubnet]
      },
      securityGroups: [this.securityGroup]
    });

    const ssmMessagesInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ssmMessagesEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.pubSubnet]
      },
      securityGroups: [this.securityGroup]
    });

    const s3InterfaceEndpoint = new ec2.CfnVPCEndpoint(this, 's3Endpoint', {
      vpcId: this.vpc.vpcId,
      serviceName: `com.amazonaws.${this.region}.s3`,
      routeTableIds: [this.publicRT.attrRouteTableId, this.priv1RT.attrRouteTableId, this.priv2RT.attrRouteTableId]
    });

    const router1 = this.createRouter('router1', 'ONPREM-ROUTER1');
    const router2 = this.createRouter('router2', 'ONPREM-ROUTER2');

    router1.node.addDependency(ssmInterfaceEndpoint, ssmEc2MessagesInterfaceEndpoint, ssmMessagesInterfaceEndpoint);
    router2.node.addDependency(ssmInterfaceEndpoint, ssmEc2MessagesInterfaceEndpoint, ssmMessagesInterfaceEndpoint);

    const attachEni1Router1 = new ec2.CfnNetworkInterfaceAttachment(this, 'attachEni1Router1', {
      instanceId: router1.instanceId,
      networkInterfaceId: this.eniR1Private.attrId,
      deviceIndex: "1"
    });

    const attachEni1Router2 = new ec2.CfnNetworkInterfaceAttachment(this, 'attachEni1Router2', {
      instanceId: router2.instanceId,
      networkInterfaceId: this.eniR2Private.attrId,
      deviceIndex: "1"
    });

    const server1 = this.createServer('server1', this.priv1Subnet, 'ONPREM-SERVER1');
    const server2 = this.createServer('server2', this.priv2Subnet, 'ONPREM-SERVER2');

    server1.node.addDependency(ssmInterfaceEndpoint, ssmEc2MessagesInterfaceEndpoint, ssmMessagesInterfaceEndpoint);
    server2.node.addDependency(ssmInterfaceEndpoint, ssmEc2MessagesInterfaceEndpoint, ssmMessagesInterfaceEndpoint);

    return {router1, router2};
  }

  private createEc2Role() {
    const ec2PolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:DescribeAssociation',
        'ssm:GetDeployablePatchSnapshotForInstance',
        'ssm:GetDocument',
        'ssm:DescribeDocument',
        'ssm:GetManifest',
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:ListAssociations',
        'ssm:ListInstanceAssociations',
        'ssm:PutInventory',
        'ssm:PutComplianceItems',
        'ssm:PutConfigurePackageResult',
        'ssm:UpdateAssociationStatus',
        'ssm:UpdateInstanceAssociationStatus',
        'ssm:UpdateInstanceInformation',
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
        'ec2messages:AcknowledgeMessage',
        'ec2messages:DeleteMessage',
        'ec2messages:FailMessage',
        'ec2messages:GetEndpoint',
        'ec2messages:GetMessages',
        'ec2messages:SendReply',
        's3:*',
        'sns:*'
    ],
      resources: ['*']
    });

    const ec2Policy = new iam.Policy(this, 'Ec2Policy', {policyName: 'root'});
    ec2Policy.addStatements(ec2PolicyStatement);

    const principal = new iam.ServicePrincipal('ec2.amazonaws.com');
    this.ec2Role = new iam.Role(this, 'Ec2Role', {
      assumedBy: principal,
      path: '/',
    });
    this.ec2Role.grant(principal, 'sts:AssumeRole');
    ec2Policy.attachToRole(this.ec2Role);
  }

  private createRouter(name: string, tag: string): ec2.Instance {
    const router = new ec2.Instance(this, name, {
      vpc: this.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.genericLinux({'us-east-1': 'ami-0ac80df6eff0e70b5'}),
      vpcSubnets: {
        subnets: [this.pubSubnet]
      },
      securityGroup: this.securityGroup,
      role: this.ec2Role,
      sourceDestCheck: false,
      userData: ec2.UserData.custom(
`#!/bin/bash -xe
apt-get update && apt-get install -y strongswan wget
mkdir /home/ubuntu/demo_assets
cd /home/ubuntu/demo_assets
wget https://raw.githubusercontent.com/acantril/learn-cantrill-io-labs/master/AWS_HYBRID_AdvancedVPN/OnPremRouter1/ipsec-vti.sh
wget https://raw.githubusercontent.com/acantril/learn-cantrill-io-labs/master/AWS_HYBRID_AdvancedVPN/OnPremRouter1/ipsec.conf
wget https://raw.githubusercontent.com/acantril/learn-cantrill-io-labs/master/AWS_HYBRID_AdvancedVPN/OnPremRouter1/ipsec.secrets
wget https://raw.githubusercontent.com/acantril/learn-cantrill-io-labs/master/AWS_HYBRID_AdvancedVPN/OnPremRouter1/51-eth1.yaml
wget https://raw.githubusercontent.com/acantril/learn-cantrill-io-labs/master/AWS_HYBRID_AdvancedVPN/OnPremRouter1/ffrouting-install.sh
chown ubuntu:ubuntu /home/ubuntu/demo_assets -R
cp /home/ubuntu/demo_assets/51-eth1.yaml /etc/netplan
netplan --debug apply`
      )
    });
    Tags.of(router).add('Name', tag);

    return router;
  }

  private createServer(name: string, subnet: ec2.ISubnet, tag: string): ec2.Instance {
    const server = new ec2.Instance(this, name, {
      vpc: this.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux(),
      vpcSubnets: {
        subnets: [subnet]
      },
      securityGroup: this.securityGroup,
      role: this.ec2Role
    });

    return server;
  }

  private outputs(router1: ec2.Instance, router2: ec2.Instance) {
    new CfnOutput(this, 'Router1Public', {
      description: 'Public IP of Router1',
      value: router1.instancePublicIp
    });

    new CfnOutput(this, 'Router2Public', {
      description: 'Public IP of Router2',
      value: router2.instancePublicIp
    });

    new CfnOutput(this, 'Router1Private', {
      description: 'Private IP of Router1',
      value: router1.instancePrivateIp
    });

    new CfnOutput(this, 'Router2Private', {
      description: 'Private IP of Router2',
      value: router2.instancePrivateIp
    });
  }
}